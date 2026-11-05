import type {
  AppConfig,
  LoadedScraper,
  LoggerLike,
  StremioStream,
  StreamRequest,
} from "../types.js";
import type { CinemetaClient } from "../cinemeta/client.js";
import {
  MAX_STREAMS,
  mapScraperStreams,
  sortStreams,
} from "../addon/mapStreams.js";
import { withTimeout } from "../util/concurrency.js";
import { scraperSupports } from "./loader.js";
import type { SnapshotManager } from "./snapshot.js";

const MAX_CACHE_ENTRIES = 500;

interface CacheEntry {
  expiresAt: number;
  streams: StremioStream[];
}

interface CollectedStreams {
  scraper: LoadedScraper;
  streams: unknown[];
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

async function collectStreams(options: {
  scrapers: LoadedScraper[];
  concurrency: number;
  deadlineMs: number;
  perProviderTimeoutMs: number;
  logger: LoggerLike;
  run: (scraper: LoadedScraper) => Promise<unknown[]>;
}): Promise<CollectedStreams[]> {
  const {
    scrapers,
    concurrency,
    deadlineMs,
    perProviderTimeoutMs,
    logger,
    run,
  } = options;
  const results: CollectedStreams[] = [];
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
        if (Array.isArray(streams)) results.push({ scraper, streams });
      } catch (error) {
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
  return results;
}

export class StreamPipeline {
  private readonly config: AppConfig;
  private readonly logger: LoggerLike;
  private readonly snapshots: SnapshotManager;
  private readonly cinemeta: CinemetaClient;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<StremioStream[]>>();

  constructor(options: StreamPipelineOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.snapshots = options.snapshots;
    this.cinemeta = options.cinemeta;
  }

  async handle(
    request: StreamRequest,
    signal?: AbortSignal,
  ): Promise<StremioStream[]> {
    if (signal?.aborted) return [];

    const cacheKey = `${request.type}:${request.imdbId}:${request.season ?? ""}:${request.episode ?? ""}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.streams;

    const existing = this.inflight.get(cacheKey);
    if (existing) return existing;

    const startedAt = Date.now();
    const task = this.produce(request, signal, cacheKey, startedAt);
    this.inflight.set(cacheKey, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  private async produce(
    request: StreamRequest,
    signal: AbortSignal | undefined,
    cacheKey: string,
    startedAt: number,
  ): Promise<StremioStream[]> {
    try {
      const tmdbId = await this.cinemeta.resolveTmdbId(request.type, request.imdbId);
      if (tmdbId === null) {
        this.logger.info("nuvio_tmdb_id_missing", {
          type: request.type,
          imdbId: request.imdbId,
        });
        return [];
      }

      const snapshot = await this.snapshots.ensure();
      if (!snapshot) {
        this.logger.warn("nuvio_snapshot_unavailable", {
          type: request.type,
          imdbId: request.imdbId,
        });
        return [];
      }
      if (signal?.aborted) return [];

      const scrapers = snapshot.scrapers.filter((scraper) =>
        scraperSupports(scraper, request.type),
      );
      const mediaType = request.type === "movie" ? "movie" : "tv";

      const collected = await collectStreams({
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

      const streams = sortStreams(
        collected.flatMap((result) =>
          mapScraperStreams(result.streams, {
            scraperId: result.scraper.entry.id,
            scraperName: result.scraper.entry.name,
            proxyEnabled: this.config.proxyEnabled,
          }),
        ),
      ).slice(0, MAX_STREAMS);

      if (this.config.streamCacheTtlMs > 0 && !signal?.aborted) {
        this.store(cacheKey, streams);
      }

      this.logger.info("nuvio_streams_resolved", {
        type: request.type,
        imdbId: request.imdbId,
        tmdbId,
        scrapers: scrapers.length,
        responded: collected.length,
        streams: streams.length,
        durationMs: Date.now() - startedAt,
      });

      return streams;
    } catch (error) {
      this.logger.error("nuvio_stream_request_failed", {
        type: request.type,
        imdbId: request.imdbId,
        error: errorMessage(error),
      });
      return [];
    }
  }

  private store(key: string, streams: StremioStream[]): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, {
      expiresAt: Date.now() + this.config.streamCacheTtlMs,
      streams,
    });
  }
}
