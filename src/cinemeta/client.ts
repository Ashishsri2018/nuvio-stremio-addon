import type { AppConfig, CinemetaMeta, LoggerLike } from "../types.js";
import { nativeFetch } from "../util/nativeFetch.js";

const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;

interface CacheEntry {
  expiresAt: number;
  value: number | null;
}

export interface CinemetaClientOptions {
  config: AppConfig;
  logger: LoggerLike;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toTmdbId(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export class CinemetaClient {
  private readonly config: AppConfig;
  private readonly logger: LoggerLike;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: CinemetaClientOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? nativeFetch;
  }

  async resolveTmdbId(
    type: "movie" | "series",
    imdbId: string,
  ): Promise<number | null> {
    const key = `${type}:${imdbId}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let value = await this.fromCinemeta(type, imdbId);
    if (value !== null) {
      this.store(key, value, SUCCESS_TTL_MS);
      return value;
    }

    if (this.config.tmdbApiKey) {
      value = await this.fromTmdb(type, imdbId);
      if (value !== null) {
        this.store(key, value, SUCCESS_TTL_MS);
        return value;
      }
    }

    this.store(key, null, MISS_TTL_MS);
    return null;
  }

  private async fromCinemeta(
    type: "movie" | "series",
    imdbId: string,
  ): Promise<number | null> {
    const url = `${this.config.cinemetaUrl}/meta/${type}/${encodeURIComponent(imdbId)}.json`;
    const data = await this.fetchJson(url);
    if (!isRecord(data) || !isRecord(data.meta)) return null;
    const id = toTmdbId((data.meta as CinemetaMeta).moviedb_id);
    if (id !== null) {
      this.logger.debug("tmdb_id_resolved", { imdbId, type, via: "cinemeta" });
    }
    return id;
  }

  private async fromTmdb(
    type: "movie" | "series",
    imdbId: string,
  ): Promise<number | null> {
    if (!this.config.tmdbApiKey) return null;
    const url =
      `${this.config.tmdbUrl}/find/${encodeURIComponent(imdbId)}` +
      `?external_source=imdb_id&api_key=${encodeURIComponent(this.config.tmdbApiKey)}`;
    const data = await this.fetchJson(url);
    if (!isRecord(data)) return null;
    const results = type === "series" ? data.tv_results : data.movie_results;
    if (!Array.isArray(results) || results.length === 0) return null;
    const first = results[0];
    if (!isRecord(first)) return null;
    const id = toTmdbId(first.id);
    if (id !== null) {
      this.logger.debug("tmdb_id_resolved", { imdbId, type, via: "tmdb" });
    }
    return id;
  }

  private async fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error("metadata request timed out"));
    }, this.config.httpTimeoutMs);
    timer.unref?.();

    try {
      const response = await this.fetchImpl(url, {
        headers: { Accept: "application/json" },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const text = await response.text();
      return text.length > 0 ? (JSON.parse(text) as unknown) : null;
    } catch (error) {
      this.logger.debug("metadata_request_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private store(key: string, value: number | null, ttlMs: number): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { expiresAt: Date.now() + ttlMs, value });
  }
}
