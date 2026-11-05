import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "./types.js";

const envBool = (def: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === "") return def;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off"].includes(normalized)) return false;
    }
    return value;
  }, z.boolean());

const envInt = (def: number, min: number, max: number) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === "") return def;
      if (typeof value === "number") return value;
      if (typeof value === "string" && value.trim() !== "") return Number(value);
      return value;
    },
    z.number().int().min(min).max(max),
  );

const envNumber = (def: number, min: number, max: number) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === "") return def;
      if (typeof value === "number") return value;
      if (typeof value === "string" && value.trim() !== "") return Number(value);
      return value;
    },
    z.number().min(min).max(max),
  );

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === "" ? null : value));

const envList = z.preprocess(
  (value) => {
    if (value === undefined || value === "") return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      return value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
    return value;
  },
  z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/, "must be a scraper id")),
);

const schema = z.object({
  PORT: envInt(7000, 1, 65535),
  NUVIO_SOURCE: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must be owner/repo")
    .default("eclipsia/nuvio-plugin"),
  NUVIO_BRANCH: z.string().trim().min(1).default("main"),
  NUVIO_SHA: z
    .string()
    .trim()
    .regex(/^$|^[0-9a-fA-F]{7,40}$/, "must be a git commit sha")
    .default(""),
  NUVIO_UPDATE_INTERVAL_HOURS: envNumber(24, 1, 168),
  NUVIO_CACHE_DIR: optionalString,
  NUVIO_CONCURRENCY: envInt(8, 1, 32),
  SCRAPER_CONCURRENCY: envInt(12, 1, 40),
  SCRAPER_TIMEOUT_MS: envInt(12000, 1000, 120000),
  GLOBAL_DEADLINE_MS: envInt(20000, 2000, 300000),
  HTTP_TIMEOUT_MS: envInt(15000, 1000, 120000),
  STREAM_CACHE_TTL_MS: envInt(60000, 0, 3600000),
  TMDB_API_KEY: optionalString,
  SCRAPER_SETTINGS_JSON: optionalString,
  DISABLED_SCRAPERS: envList,
  PROXY_ENABLED: envBool(true),
  CINEMETA_URL: z.string().url().default("https://v3-cinemeta.strem.io"),
  TMDB_URL: z.string().url().default("https://api.themoviedb.org/3"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  CRON_SECRET: optionalString,
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseScraperSettings(
  raw: string | null,
): Record<string, Record<string, unknown>> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("SCRAPER_SETTINGS_JSON must be valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new ConfigError("SCRAPER_SETTINGS_JSON must be an object keyed by scraper id");
  }
  const result: Record<string, Record<string, unknown>> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      throw new ConfigError(`SCRAPER_SETTINGS_JSON.${id} must be an object`);
    }
    result[id] = value;
  }
  return result;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid configuration: ${details}`);
  }

  const value = parsed.data;
  return {
    port: value.PORT,
    source: value.NUVIO_SOURCE,
    branch: value.NUVIO_BRANCH,
    pinnedSha: value.NUVIO_SHA ? value.NUVIO_SHA.toLowerCase() : null,
    updateIntervalHours: value.NUVIO_UPDATE_INTERVAL_HOURS,
    cacheDir: path.resolve(value.NUVIO_CACHE_DIR ?? path.join(os.tmpdir(), "nuvio-addon")),
    downloadConcurrency: value.NUVIO_CONCURRENCY,
    scraperConcurrency: value.SCRAPER_CONCURRENCY,
    scraperTimeoutMs: value.SCRAPER_TIMEOUT_MS,
    globalDeadlineMs: value.GLOBAL_DEADLINE_MS,
    httpTimeoutMs: value.HTTP_TIMEOUT_MS,
    streamCacheTtlMs: value.STREAM_CACHE_TTL_MS,
    tmdbApiKey: value.TMDB_API_KEY,
    scraperSettings: parseScraperSettings(value.SCRAPER_SETTINGS_JSON),
    disabledScrapers: Array.from(new Set(value.DISABLED_SCRAPERS)),
    proxyEnabled: value.PROXY_ENABLED,
    cinemetaUrl: trimTrailingSlash(value.CINEMETA_URL),
    tmdbUrl: trimTrailingSlash(value.TMDB_URL),
    logLevel: value.LOG_LEVEL,
    cronSecret: value.CRON_SECRET,
  };
}
