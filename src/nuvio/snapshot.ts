import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AppConfig,
  HealthReport,
  LoadedScraper,
  LoggerLike,
  NuvioManifest,
  NuvioScraperEntry,
  NuvioSnapshot,
} from "../types.js";
import { computeSnapshotSha, CodebergClient } from "../source/codeberg.js";
import { mapLimit, mapLimitSettled, randomInt } from "../util/concurrency.js";
import {
  ensureDir,
  listDirs,
  readJsonFile,
  removeDir,
  writeFileAtomic,
  writeJsonAtomic,
} from "../util/fs.js";
import { loadScraper, logScraperFailure } from "./loader.js";
import { parseNuvioManifest, selectScrapers } from "./manifest.js";

const MAX_PROVIDER_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{6,79}$/;
const TEMP_MARKER = ".tmp-";
const LOAD_CONCURRENCY = 8;

export type SnapshotSource = "disk" | "bundled" | "network";

interface DiskState {
  sha: string;
  fetchedAt: number;
}

interface SnapshotData {
  manifestBytes: Buffer;
  manifest: NuvioManifest;
  entries: NuvioScraperEntry[];
  files: Map<string, Buffer>;
  failed: number;
}

interface LoadResult {
  entry: NuvioScraperEntry;
  scraper?: LoadedScraper;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class SnapshotManager {
  private snapshot: NuvioSnapshot | null = null;
  private inflight: Promise<NuvioSnapshot | null> | null = null;
  private lastError: string | null = null;
  private refreshing = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: LoggerLike,
    private readonly client: CodebergClient,
  ) {}

  getSnapshot(): NuvioSnapshot | null {
    return this.snapshot;
  }

  getHealth(): HealthReport {
    const snapshot = this.snapshot;
    const status: HealthReport["status"] = snapshot
      ? this.lastError
        ? "degraded"
        : "ok"
      : this.lastError
        ? "error"
        : "degraded";
    return {
      status,
      sha: snapshot?.sha ?? null,
      fetchedAt: snapshot ? new Date(snapshot.fetchedAt).toISOString() : null,
      scraperCount: snapshot?.scrapers.length ?? 0,
      lastError: this.lastError,
      refreshing: this.refreshing,
    };
  }

  async ensure(): Promise<NuvioSnapshot | null> {
    if (this.snapshot && this.isFresh(this.snapshot.fetchedAt)) {
      return this.snapshot;
    }
    return this.refresh(false);
  }

  async refresh(force: boolean): Promise<NuvioSnapshot | null> {
    if (this.inflight) return this.inflight;

    const task = (async () => {
      this.refreshing = true;
      try {
        return await this.runRefresh(force);
      } finally {
        this.refreshing = false;
        this.inflight = null;
      }
    })();
    this.inflight = task;
    return task;
  }

  private async runRefresh(force: boolean): Promise<NuvioSnapshot | null> {
    try {
      if (!force) {
        const fresh = await this.loadFromDisk(true);
        if (fresh) return this.activate(fresh, "disk");
        const bundled = await this.loadBundled(false);
        if (bundled && this.matchesPin(bundled.sha)) {
          const active = this.activate(bundled, "bundled");
          if (!this.isFresh(bundled.fetchedAt)) this.scheduleRefresh();
          return active;
        }
      }

      const diskState = await this.readState();
      let targetSha: string;
      let fetchSha: string | null;
      let data: SnapshotData | null = null;

      if (this.config.pinnedSha) {
        targetSha = this.config.pinnedSha;
        fetchSha = targetSha;
      } else {
        try {
          targetSha = await this.client.resolveHead();
          fetchSha = targetSha;
        } catch (error) {
          this.logger.warn("nuvio_head_failed", { error: errorMessage(error) });
          data = await this.downloadSnapshot(null);
          targetSha = computeSnapshotSha([
            data.manifestBytes,
            ...data.files.values(),
          ]);
          fetchSha = null;
        }
      }

      if (!force && diskState?.sha === targetSha) {
        const disk = await this.loadFromDisk(false, targetSha);
        if (disk) {
          const refreshed: NuvioSnapshot = { ...disk, fetchedAt: Date.now() };
          await this.writeState(targetSha, refreshed.fetchedAt);
          return this.activate(refreshed, "disk");
        }
      }

      if (!data) data = await this.downloadSnapshot(fetchSha);
      const scrapers = await this.evaluateSnapshot(data);
      if (scrapers.length === 0) {
        throw new Error("no scrapers could be loaded from the new snapshot");
      }

      await this.persist(targetSha, data);
      const snapshot: NuvioSnapshot = {
        sha: targetSha,
        fetchedAt: Date.now(),
        scrapers,
      };
      await this.writeState(targetSha, snapshot.fetchedAt);
      this.activate(snapshot, "network");
      await this.cleanupSnapshots(targetSha);
      return snapshot;
    } catch (error) {
      const bundled = await this.loadBundled(false);
      if (bundled) {
        this.logger.warn("nuvio_snapshot_refresh_failed_using_bundled", {
          error: errorMessage(error),
        });
        return this.activate(bundled, "bundled");
      }
      this.lastError = errorMessage(error);
      this.logger.error("nuvio_snapshot_refresh_failed", {
        error: this.lastError,
      });
      return this.snapshot;
    }
  }

  private matchesPin(sha: string): boolean {
    return !this.config.pinnedSha || sha.startsWith(this.config.pinnedSha);
  }

  private scheduleRefresh(): void {
    const timer = setTimeout(() => {
      void this.refresh(true).catch(() => undefined);
    }, 0);
    timer.unref?.();
  }

  private activate(
    snapshot: NuvioSnapshot,
    source: SnapshotSource,
  ): NuvioSnapshot {
    this.snapshot = snapshot;
    this.lastError = null;
    this.logger.info("nuvio_snapshot_activated", {
      source,
      sha: snapshot.sha,
      scrapers: snapshot.scrapers.length,
      fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
    });
    return snapshot;
  }

  private isFresh(fetchedAt: number): boolean {
    return Date.now() - fetchedAt < this.config.updateIntervalHours * 3_600_000;
  }

  private async downloadSnapshot(fetchSha: string | null): Promise<SnapshotData> {
    const manifestBytes = await this.client.fetchFile(fetchSha, "manifest.json");
    if (manifestBytes.length > MAX_MANIFEST_BYTES) {
      throw new Error("manifest.json exceeds the size limit");
    }
    const manifest = parseNuvioManifest(manifestBytes);
    const entries = selectScrapers(manifest, this.config.disabledScrapers);
    if (entries.length === 0) {
      throw new Error("manifest.json has no enabled scrapers");
    }

    const results = await mapLimitSettled(
      entries,
      this.config.downloadConcurrency,
      async (entry) => {
        const buffer = await this.client.fetchFile(fetchSha, entry.filename);
        if (buffer.length < 1 || buffer.length > MAX_PROVIDER_BYTES) {
          throw new Error(
            `${entry.filename} has invalid size (${buffer.length} bytes)`,
          );
        }
        return { entry, buffer };
      },
    );

    const files = new Map<string, Buffer>();
    let failed = 0;
    let bytes = 0;
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const entry = entries[index] as NuvioScraperEntry;
      if (result.status === "fulfilled") {
        files.set(result.value.entry.filename, result.value.buffer);
        bytes += result.value.buffer.length;
      } else {
        failed += 1;
        logScraperFailure(this.logger, entry, result.reason);
      }
    }
    if (files.size === 0) {
      throw new Error("no scraper files could be downloaded");
    }

    this.logger.info("nuvio_providers_downloaded", {
      sha: fetchSha ?? "branch",
      downloaded: files.size,
      failed,
      bytes,
    });

    return {
      manifestBytes,
      manifest,
      entries: entries.filter((entry) => files.has(entry.filename)),
      files,
      failed,
    };
  }

  private async evaluateSnapshot(data: SnapshotData): Promise<LoadedScraper[]> {
    const results = await mapLimit<SnapshotData["entries"][number], LoadResult>(
      data.entries,
      LOAD_CONCURRENCY,
      async (entry) => {
        const buffer = data.files.get(entry.filename);
        if (!buffer) {
          return { entry, error: "provider file missing" };
        }
        try {
          const scraper = await loadScraper({
            entry,
            code: buffer.toString("utf8"),
            tmdbApiKey: this.config.tmdbApiKey,
            envSettings: this.config.scraperSettings[entry.id] ?? {},
            fetchTimeoutMs: this.config.httpTimeoutMs,
          });
          return { entry, scraper };
        } catch (error) {
          return { entry, error: errorMessage(error) };
        }
      },
    );

    const scrapers: LoadedScraper[] = [];
    for (const result of results) {
      if (result.scraper) {
        scrapers.push(result.scraper);
      } else {
        logScraperFailure(
          this.logger,
          result.entry,
          new Error(result.error ?? "provider load failed"),
        );
      }
    }

    this.logger.info("nuvio_providers_loaded", {
      loaded: scrapers.length,
      failed: results.length - scrapers.length,
    });
    return scrapers;
  }

  private async loadFromDisk(
    requireFresh: boolean,
    expectedSha?: string,
  ): Promise<NuvioSnapshot | null> {
    const state = await this.readState();
    if (!state) return null;
    if (!SNAPSHOT_ID.test(state.sha)) return null;
    if (expectedSha && state.sha !== expectedSha) return null;
    if (requireFresh && !this.isFresh(state.fetchedAt)) return null;

    return this.loadFromDirectory(
      this.snapshotDir(state.sha),
      state.sha,
      state.fetchedAt,
    );
  }

  private async loadBundled(
    requireFresh: boolean,
  ): Promise<NuvioSnapshot | null> {
    const dir = this.config.bundledDir;
    if (!dir) return null;

    let state: DiskState | null = null;
    try {
      const value = await readJsonFile<unknown>(path.join(dir, "state.json"));
      if (
        isRecord(value) &&
        typeof value.sha === "string" &&
        SNAPSHOT_ID.test(value.sha) &&
        typeof value.fetchedAt === "number" &&
        Number.isFinite(value.fetchedAt)
      ) {
        state = { sha: value.sha, fetchedAt: value.fetchedAt };
      }
    } catch {
      return null;
    }
    if (!state) return null;
    if (requireFresh && !this.isFresh(state.fetchedAt)) return null;

    return this.loadFromDirectory(dir, state.sha, state.fetchedAt);
  }

  private async loadFromDirectory(
    dir: string,
    sha: string,
    fetchedAt: number,
  ): Promise<NuvioSnapshot | null> {
    try {
      const manifestBytes = await fs.readFile(path.join(dir, "manifest.json"));
      const manifest = parseNuvioManifest(manifestBytes);
      const entries = selectScrapers(manifest, this.config.disabledScrapers);
      const files = new Map<string, Buffer>();
      for (const entry of entries) {
        const buffer = await fs.readFile(path.join(dir, entry.filename));
        if (buffer.length < 1 || buffer.length > MAX_PROVIDER_BYTES) continue;
        files.set(entry.filename, buffer);
      }
      if (files.size === 0) return null;

      const data: SnapshotData = {
        manifestBytes,
        manifest,
        entries: entries.filter((entry) => files.has(entry.filename)),
        files,
        failed: 0,
      };
      const scrapers = await this.evaluateSnapshot(data);
      if (scrapers.length === 0) return null;

      this.logger.info("nuvio_snapshot_loaded_from_directory", {
        dir,
        sha,
        scrapers: scrapers.length,
      });
      return { sha, fetchedAt, scrapers };
    } catch (error) {
      this.logger.warn("nuvio_snapshot_disk_load_failed", {
        sha,
        error: errorMessage(error),
      });
      return null;
    }
  }

  private async persist(sha: string, data: SnapshotData): Promise<void> {
    const destination = this.snapshotDir(sha);
    const staging = `${destination}${TEMP_MARKER}${randomInt(0, 0x7fffffff).toString(36)}`;
    await removeDir(staging);
    await ensureDir(staging);
    try {
      for (const [filename, buffer] of data.files) {
        const target = path.join(staging, filename);
        await ensureDir(path.dirname(target));
        await fs.writeFile(target, buffer);
      }
      await writeFileAtomic(path.join(staging, "manifest.json"), data.manifestBytes);
      await removeDir(destination);
      await fs.rename(staging, destination);
    } catch (error) {
      await removeDir(staging).catch(() => undefined);
      throw error;
    }
  }

  private async readState(): Promise<DiskState | null> {
    try {
      const value = await readJsonFile<unknown>(this.statePath());
      if (!isRecord(value)) return null;
      if (typeof value.sha !== "string" || !SNAPSHOT_ID.test(value.sha)) return null;
      if (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt)) {
        return null;
      }
      return { sha: value.sha, fetchedAt: value.fetchedAt };
    } catch {
      return null;
    }
  }

  private async writeState(sha: string, fetchedAt: number): Promise<void> {
    await writeJsonAtomic(this.statePath(), { sha, fetchedAt });
  }

  private async cleanupSnapshots(currentSha: string): Promise<void> {
    for (const name of await listDirs(this.config.cacheDir)) {
      if (name === currentSha) continue;
      if (name.includes(TEMP_MARKER)) {
        await removeDir(path.join(this.config.cacheDir, name)).catch(() => undefined);
        continue;
      }
      if (!SNAPSHOT_ID.test(name)) continue;
      await removeDir(path.join(this.config.cacheDir, name)).catch(() => undefined);
    }
  }

  private statePath(): string {
    return path.join(this.config.cacheDir, "state.json");
  }

  private snapshotDir(sha: string): string {
    return path.join(this.config.cacheDir, sha);
  }
}
