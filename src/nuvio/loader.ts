import * as cheerio from "cheerio";
import CryptoJS from "crypto-js";
import type { LoadedScraper, LoggerLike, NuvioScraperEntry } from "../types.js";
import { withTimeout } from "../util/concurrency.js";
import { nativeFetch } from "../util/nativeFetch.js";

const ON_SETTINGS_TIMEOUT_MS = 3000;

type EvaluatedModule = Record<string, unknown>;

export interface LoadScraperOptions {
  entry: NuvioScraperEntry;
  code: string;
  tmdbApiKey: string | null;
  envSettings: Record<string, unknown>;
  fetchTimeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createProviderFetch(timeoutMs: number): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    return nativeFetch(input, { ...init, signal });
  }) as typeof fetch;
}

const providerRequire = (id: string): unknown => {
  const name = id.trim();
  switch (name) {
    case "cheerio":
    case "cheerio-without-node-native":
      return cheerio;
    case "crypto-js":
      return CryptoJS;
    default:
      throw new Error(`Provider module is not available: ${name}`);
  }
};

function evaluateModule(options: {
  code: string;
  settings: Record<string, unknown>;
  tmdbApiKey: string | null;
  fetchTimeoutMs: number;
  filename: string;
}): EvaluatedModule {
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  const fn = new Function(
    "module",
    "exports",
    "require",
    "fetch",
    "TMDB_API_KEY",
    "SCRAPER_SETTINGS",
    "__filename",
    "__dirname",
    `"use strict";\n${options.code}`,
  ) as (...args: unknown[]) => void;

  fn(
    moduleObject,
    moduleObject.exports,
    providerRequire,
    createProviderFetch(options.fetchTimeoutMs),
    options.tmdbApiKey ?? undefined,
    options.settings,
    options.filename,
    "providers",
  );
  return moduleObject.exports;
}

async function collectDefaults(onSettings: unknown): Promise<Record<string, unknown>> {
  if (typeof onSettings !== "function") return {};
  let schema: unknown;
  try {
    schema = await withTimeout(
      Promise.resolve((onSettings as () => unknown)()),
      ON_SETTINGS_TIMEOUT_MS,
      "onSettings",
    );
  } catch {
    return {};
  }

  const fields = Array.isArray(schema)
    ? schema
    : isRecord(schema) && Array.isArray(schema.fields)
      ? schema.fields
      : [];
  const defaults: Record<string, unknown> = {};
  for (const field of fields) {
    if (!isRecord(field)) continue;
    const key = typeof field.key === "string" ? field.key : "";
    if (!key || field.defaultValue === undefined) continue;
    defaults[key] = field.defaultValue;
  }
  return defaults;
}

function sameValues(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) => key in right && JSON.stringify(left[key]) === JSON.stringify(right[key]),
  );
}

export async function loadScraper(options: LoadScraperOptions): Promise<LoadedScraper> {
  const overrides = { ...options.envSettings };
  const base = {
    code: options.code,
    tmdbApiKey: options.tmdbApiKey,
    fetchTimeoutMs: options.fetchTimeoutMs,
    filename: options.entry.filename,
  };

  let evaluated = evaluateModule({ ...base, settings: overrides });
  if (typeof evaluated.getStreams !== "function") {
    throw new Error(`${options.entry.id} does not export getStreams()`);
  }

  const defaults = await collectDefaults(evaluated.onSettings);
  let effective = overrides;
  if (Object.keys(defaults).length > 0) {
    const merged = { ...defaults, ...overrides };
    if (!sameValues(merged, overrides)) {
      effective = merged;
      evaluated = evaluateModule({ ...base, settings: effective });
      if (typeof evaluated.getStreams !== "function") {
        throw new Error(`${options.entry.id} does not export getStreams()`);
      }
    }
  }

  const getStreams = evaluated.getStreams as (
    tmdbId: number,
    mediaType: "movie" | "tv",
    season?: number,
    episode?: number,
  ) => Promise<unknown>;

  return {
    entry: options.entry,
    settings: effective,
    getStreams: async (tmdbId, mediaType, season, episode) => {
      const result = await getStreams(tmdbId, mediaType, season, episode);
      return Array.isArray(result) ? result : [];
    },
  };
}

export function scraperSupports(
  scraper: LoadedScraper,
  type: "movie" | "series",
): boolean {
  const types = scraper.entry.supportedTypes;
  if (type === "movie") return types.includes("movie");
  return types.includes("tv") || types.includes("series");
}

export function logScraperFailure(
  logger: LoggerLike,
  entry: NuvioScraperEntry,
  error: unknown,
): void {
  logger.warn("nuvio_scraper_load_failed", {
    scraper: entry.id,
    error: error instanceof Error ? error.message : String(error),
  });
}
