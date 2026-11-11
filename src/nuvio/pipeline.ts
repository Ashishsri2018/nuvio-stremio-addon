import type {
  AppConfig,
  LoadedScraper,
  LoggerLike,
  StremioStream,
  StremioSubtitle,
  StreamRequest,
} from "../types.js";
import type { CinemetaClient } from "../cinemeta/client.js";
import {
  MAX_STREAMS,
  mapScraperStreams,
  sortStreams,
} from "../addon/mapStreams.js";
import { contentIdOf, requestLogFields } from "../addon/parseId.js";
import { TimeoutError, withTimeout } from "../util/concurrency.js";
import type {
  MetadataCacheStats,
  StreamCacheStats,
  TelemetryMetrics,
} from "../telemetry.js";
import { scraperSupports } from "./loader.js";
import {
  ProviderMetrics,
  type ProviderOutcome,
  type ProviderStatsReport,
} from "./metrics.js";
import type { SnapshotManager } from "./snapshot.js";

const MAX_CACHE_ENTRIES = 500;

interface CacheEntry {
  expiresAt: number;
  streams: StremioStream[];
  meta: StreamsMeta;
}

interface CollectedStreams {
  scraper: LoadedScraper;
  streams: unknown[];
}

interface CollectResult {
  collected: CollectedStreams[];
  stats: ProviderOutcome[];
}

interface StreamsMeta {
  tmdbId: number;
  providers: number;
  responded: number;
  streams: number;
  zeroHits: string[];
  failed: string[];
  skipped: string[];
  slowest: { provider: string; latencyMs: number } | null;
}

type Outcome =
  | "ok"
  | "tmdb_missing"
  | "snapshot_unavailable"
  | "aborted"
  | "error";

interface ProduceResult {
  streams: StremioStream[];
  outcome: Outcome;
  meta: StreamsMeta | null;
}

export interface StreamPipelineOptions {
  config: AppConfig;
  logger: LoggerLike;
  snapshots: SnapshotManager;
  cinemeta: CinemetaClient;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function slowestProvider(
  stats: ProviderOutcome[],
): StreamsMeta["slowest"] {
  let slowest: StreamsMeta["slowest"] = null;
  for (const stat of stats) {
    if (stat.error === "deadline") continue;
    if (!slowest || stat.latencyMs > slowest.latencyMs) {
      slowest = { provider: stat.id, latencyMs: stat.latencyMs };
    }
  }
  return slowest;
}

async function collectStreams(options: {
  scrapers: LoadedScraper[];
  concurrency: number;
  deadlineMs: number;
  perProviderTimeoutMs: number;
  logger: LoggerLike;
  run: (scraper: LoadedScraper) => Promise<unknown[]>;
}): Promise<CollectResult> {
  const {
    scrapers,
    concurrency,
    deadlineMs,
    perProviderTimeoutMs,
    logger,
    run,
  } = options;
  const results: CollectedStreams[] = [];
  const stats: ProviderOutcome[] = [];
  const attempted = new Set<number>();
  const deadline = Date.now() + Math.max(1, deadlineMs);
  let cursor = 0;
  let done = false;

  const worker = async (): Promise<void> => {
    while (!done) {
      const index = cursor;
      cursor += 1;
      if (index >= scrapers.length) return;
      const scraper = scrapers[index] as LoadedScraper;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        done = true;
        return;
      }
      attempted.add(index);
      const startedAt = Date.now();
      try {
        const timeoutMs =
          perProviderTimeoutMs > 0
            ? Math.min(remaining, perProviderTimeoutMs)
            : remaining;
        const streams = await withTimeout(
          Promise.resolve(run(scraper)),
          timeoutMs,
          scraper.entry.id,
        );
        const latencyMs = Date.now() - startedAt;
        if (Array.isArray(streams)) {
          results.push({ scraper, streams });
          stats.push({
            id: scraper.entry.id,
            ok: true,
            streams: streams.length,
            latencyMs,
          });
        } else {
          stats.push({
            id: scraper.entry.id,
            ok: false,
            streams: 0,
            latencyMs,
            error: "non_array",
          });
        }
      } catch (error) {
        stats.push({
          id: scraper.entry.id,
          ok: false,
          streams: 0,
          latencyMs: Date.now() - startedAt,
          error: error instanceof TimeoutError ? "timeout" : "error",
        });
        logger.debug("nuvio_scraper_failed", {
          scraper: scraper.entry.id,
          error: errorMessage(error),
        });
      }
    }
  };

  const workerCount = Math.min(Math.max(1, concurrency), scrapers.length);
  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );
  done = true;

  for (let index = 0; index < scrapers.length; index += 1) {
    if (attempted.has(index)) continue;
    const scraper = scrapers[index] as LoadedScraper;
    stats.push({
      id: scraper.entry.id,
      ok: false,
      streams: 0,
      latencyMs: 0,
      error: "deadline",
    });
  }

  return { collected: results, stats };
}

export class StreamPipeline {
  private readonly config: AppConfig;
  private readonly logger: LoggerLike;
  private readonly snapshots: SnapshotManager;
  private readonly cinemeta: CinemetaClient;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ProduceResult>>();
  private readonly metrics = new ProviderMetrics();
  private readonly requestMetrics = {
    requests: 0,
    emptyResults: 0,
    deadlineHits: 0,
    settleHits: 0,
    providerFailures: 0,
  };
  private readonly cacheStats = {
    hits: 0,
    misses: 0,
    coalesced: 0,
    sets: 0,
    evictions: 0,
    expired: 0,
  };

  constructor(options: StreamPipelineOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.snapshots = options.snapshots;
    this.cinemeta = options.cinemeta;
  }

  getProviderStats(): ProviderStatsReport {
    return this.metrics.report();
  }

  getMetrics(): TelemetryMetrics {
    return {
      requests: this.requestMetrics.requests,
      cacheHits: this.cacheStats.hits,
      cacheMisses: this.cacheStats.misses,
      emptyResults: this.requestMetrics.emptyResults,
      deadlineHits: this.requestMetrics.deadlineHits,
      settleHits: this.requestMetrics.settleHits,
      providerFailures: this.requestMetrics.providerFailures,
    };
  }

  getCacheStats(): StreamCacheStats {
    return {
      enabled: this.config.streamCacheTtlMs > 0,
      ...this.cacheStats,
      size: this.cache.size,
      maxEntries: MAX_CACHE_ENTRIES,
      ttlMs: this.config.streamCacheTtlMs,
      partialTtlMs: this.config.streamPartialCacheTtlMs,
    };
  }

  getMetadataCacheStats(): MetadataCacheStats | null {
    return this.cinemeta.getCacheStats?.() ?? null;
  }

  async collectSubtitles(
    request: StreamRequest,
    signal?: AbortSignal,
  ): Promise<StremioSubtitle[]> {
    const streams = await this.handle(request, signal);
    const seenUrls = new Set<string>();
    const subtitles: StremioSubtitle[] = [];
    for (const stream of streams) {
      for (const track of stream.subtitles ?? []) {
        if (seenUrls.has(track.url)) continue;
        seenUrls.add(track.url);
        subtitles.push(track);
      }
    }
    return subtitles;
  }

  async handle(
    request: StreamRequest,
    signal?: AbortSignal,
  ): Promise<StremioStream[]> {
    const startedAt = Date.now();
    if (signal?.aborted) {
      this.logSummary(request, startedAt, "miss", false, {
        streams: [],
        outcome: "aborted",
        meta: null,
      });
      return [];
    }

    this.requestMetrics.requests += 1;
    const cacheKey = `${request.type}:${contentIdOf(request)}:${request.season ?? ""}:${request.episode ?? ""}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        this.cacheStats.hits += 1;
        this.logSummary(request, startedAt, "hit", false, {
          streams: cached.streams,
          outcome: "ok",
          meta: cached.meta,
        });
        return cached.streams;
      }
      this.cache.delete(cacheKey);
      this.cacheStats.expired += 1;
    }
    this.cacheStats.misses += 1;

    const existing = this.inflight.get(cacheKey);
    if (existing) this.cacheStats.coalesced += 1;
    if (existing) {
      try {
        const result = await existing;
        if (result.streams.length === 0) this.requestMetrics.emptyResults += 1;
        this.logSummary(request, startedAt, "miss", true, result);
        return result.streams;
      } catch (error) {
        this.requestMetrics.emptyResults += 1;
        this.logRequestFailure(request, error);
        this.logSummary(request, startedAt, "miss", true, {
          streams: [],
          outcome: "error",
          meta: null,
        });
        return [];
      }
    }

    const task = this.produce(request, signal, cacheKey);
    this.inflight.set(cacheKey, task);
    try {
      const result = await task;
      if (result.streams.length === 0) this.requestMetrics.emptyResults += 1;
      this.logSummary(request, startedAt, "miss", false, result);
      return result.streams;
    } catch (error) {
      this.requestMetrics.emptyResults += 1;
      this.logRequestFailure(request, error);
      this.logSummary(request, startedAt, "miss", false, {
        streams: [],
        outcome: "error",
        meta: null,
      });
      return [];
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  private async produce(
    request: StreamRequest,
    signal: AbortSignal | undefined,
    cacheKey: string,
  ): Promise<ProduceResult> {
    try {
      const tmdbId =
        "tmdbId" in request
          ? request.tmdbId
          : await this.cinemeta.resolveTmdbId(request.type, request.imdbId);
      if (tmdbId === null) {
        this.logger.info("nuvio_tmdb_id_missing", {
          type: request.type,
          ...requestLogFields(request),
        });
        return { streams: [], outcome: "tmdb_missing", meta: null };
      }

      const snapshot = await this.snapshots.ensure();
      if (!snapshot) {
        this.logger.warn("nuvio_snapshot_unavailable", {
          type: request.type,
          ...requestLogFields(request),
        });
        return { streams: [], outcome: "snapshot_unavailable", meta: null };
      }
      if (signal?.aborted) {
        return { streams: [], outcome: "aborted", meta: null };
      }

      const scrapers = snapshot.scrapers.filter((scraper) =>
        scraperSupports(scraper, request.type),
      );
      const mediaType = request.type === "movie" ? "movie" : "tv";

      const { collected, stats } = await collectStreams({
        scrapers,
        concurrency: this.config.scraperConcurrency,
        deadlineMs: this.config.globalDeadlineMs,
        perProviderTimeoutMs: this.config.scraperTimeoutMs,
        logger: this.logger,
        run: (scraper) =>
          scraper.getStreams(
            tmdbId,
            mediaType,
            request.season,
            request.episode,
          ),
      });
      for (const stat of stats) this.metrics.record(stat);

      const streams = sortStreams(
        collected.flatMap((result) =>
          mapScraperStreams(result.streams, {
            scraperId: result.scraper.entry.id,
            scraperName: result.scraper.entry.name,
            proxyEnabled: this.config.proxyEnabled,
          }),
        ),
      ).slice(0, MAX_STREAMS);

      const zeroHits = stats
        .filter((stat) => stat.streams === 0)
        .map((stat) => stat.id);
      const failed = stats
        .filter((stat) => !stat.ok && stat.error !== "deadline")
        .map((stat) => stat.id);
      const skipped = stats
        .filter((stat) => stat.error === "deadline")
        .map((stat) => stat.id);
      this.requestMetrics.providerFailures += stats.filter(
        (stat) => !stat.ok && stat.error !== "deadline",
      ).length;
      if (skipped.length > 0) this.requestMetrics.deadlineHits += 1;
      const meta: StreamsMeta = {
        tmdbId,
        providers: scrapers.length,
        responded: collected.length,
        streams: streams.length,
        zeroHits,
        failed,
        skipped,
        slowest: slowestProvider(stats),
      };

      const partial =
        meta.skipped.length > 0 ||
        stats.some((stat) => !stat.ok && stat.error === "timeout");
      const ttl = partial
        ? Math.min(
            this.config.streamPartialCacheTtlMs,
            this.config.streamCacheTtlMs,
          )
        : this.config.streamCacheTtlMs;
      if (
        streams.length > 0 &&
        ttl > 0 &&
        this.config.streamCacheTtlMs > 0 &&
        !signal?.aborted
      ) {
        this.store(cacheKey, streams, meta, ttl);
      }

      return { streams, outcome: "ok", meta };
    } catch (error) {
      this.logger.error("nuvio_stream_request_failed", {
        type: request.type,
        ...requestLogFields(request),
        error: errorMessage(error),
      });
      return { streams: [], outcome: "error", meta: null };
    }
  }

  private logSummary(
    request: StreamRequest,
    startedAt: number,
    cache: "hit" | "miss",
    shared: boolean,
    result: ProduceResult,
  ): void {
    const meta = result.meta;
    this.logger.info("nuvio_streams_resolved", {
      type: request.type,
      ...requestLogFields(request),
      season: request.season,
      episode: request.episode,
      tmdbId: meta?.tmdbId ?? null,
      outcome: result.outcome,
      cache,
      shared,
      providers: meta?.providers ?? 0,
      responded: meta?.responded ?? 0,
      streams: result.streams.length,
      zeroHits: meta?.zeroHits ?? [],
      failed: meta?.failed ?? [],
      skipped: meta?.skipped ?? [],
      slowest: meta?.slowest ?? null,
      durationMs: Date.now() - startedAt,
    });
  }

  private logRequestFailure(request: StreamRequest, error: unknown): void {
    this.logger.error("nuvio_stream_request_failed", {
      type: request.type,
      ...requestLogFields(request),
      error: errorMessage(error),
    });
  }

  private store(
    key: string,
    streams: StremioStream[],
    meta: StreamsMeta,
    ttlMs: number,
  ): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
        this.cacheStats.evictions += 1;
      }
    }
    this.cache.set(key, {
      expiresAt: Date.now() + ttlMs,
      streams,
      meta,
    });
    this.cacheStats.sets += 1;
  }
}
