export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerLike {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  isLevelEnabled?(level: LogLevel): boolean;
}

export interface StremioManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  types: string[];
  resources: string[];
  idPrefixes: string[];
  catalogs: unknown[];
  behaviorHints?: { configurable?: boolean };
}

export interface StremioSubtitle {
  id: string;
  url: string;
  lang: string;
}

export interface StremioStream {
  name: string;
  title?: string;
  url?: string;
  externalUrl?: string;
  subtitles?: StremioSubtitle[];
  behaviorHints?: {
    bingeGroup?: string;
    proxyHeaders?: { request: Record<string, string> };
    videoSize?: number;
    notWebReady?: boolean;
  };
}

export interface ImdbStreamRequest {
  type: "movie" | "series";
  imdbId: string;
  season?: number;
  episode?: number;
}

export interface TmdbStreamRequest {
  type: "movie" | "series";
  tmdbId: number;
  season?: number;
  episode?: number;
}

export type StreamRequest = ImdbStreamRequest | TmdbStreamRequest;

export interface NuvioScraperEntry {
  id: string;
  name: string;
  description: string | null;
  version: string;
  author: string | null;
  supportedTypes: string[];
  filename: string;
  enabled: boolean;
  formats: string[];
  contentLanguage: string[];
  hasSettings: boolean;
  disabledPlatforms: string[];
}

export interface NuvioManifest {
  name: string;
  version: string;
  scrapers: NuvioScraperEntry[];
}

export interface NuvioRawStream {
  name?: unknown;
  title?: unknown;
  url?: unknown;
  externalUrl?: unknown;
  quality?: unknown;
  headers?: unknown;
  subtitles?: unknown;
  type?: unknown;
  server?: unknown;
}

export interface LoadedScraper {
  entry: NuvioScraperEntry;
  settings: Record<string, unknown>;
  getStreams: (
    tmdbId: number,
    mediaType: "movie" | "tv",
    season?: number,
    episode?: number,
  ) => Promise<unknown[]>;
}

export interface NuvioSnapshot {
  sha: string;
  fetchedAt: number;
  scrapers: LoadedScraper[];
}

export interface HealthReport {
  status: "ok" | "degraded" | "error";
  sha: string | null;
  fetchedAt: string | null;
  scraperCount: number;
  lastError: string | null;
  refreshing: boolean;
}

export interface CinemetaMeta {
  id?: string;
  imdb_id?: string;
  moviedb_id?: number | string;
  name?: string;
  type?: string;
}

export interface AppConfig {
  port: number;
  source: string;
  branch: string;
  pinnedSha: string | null;
  updateIntervalHours: number;
  cacheDir: string;
  bundledDir: string | null;
  downloadConcurrency: number;
  scraperConcurrency: number;
  scraperTimeoutMs: number;
  globalDeadlineMs: number;
  httpTimeoutMs: number;
  streamCacheTtlMs: number;
  streamPartialCacheTtlMs: number;
  tmdbApiKey: string | null;
  scraperSettings: Record<string, Record<string, unknown>>;
  disabledScrapers: string[];
  proxyEnabled: boolean;
  cinemetaUrl: string;
  tmdbUrl: string;
  logLevel: LogLevel;
  cronSecret: string | null;
}
