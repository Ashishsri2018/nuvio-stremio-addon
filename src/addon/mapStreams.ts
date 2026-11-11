import type { NuvioRawStream, StremioStream, StremioSubtitle } from "../types.js";
import { BLOCKER_URL_PATTERN, isWebPage } from "./urlClassifier.js";

export const MAX_STREAMS = 1000;
const DEFAULT_PER_PROVIDER_LIMIT = 100;

const BLOCKED_HEADERS = new Set([
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "content-type",
  "accept-encoding",
]);

const PLACEHOLDER_HOSTS = new Set([
  "example.com",
  "www.example.com",
  "example.org",
  "example.net",
  "localhost",
  "localhost.localdomain",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
]);

export interface MapScraperOptions {
  scraperId: string;
  scraperName: string;
  proxyEnabled: boolean;
  perProviderLimit?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isPlaceholderHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (PLACEHOLDER_HOSTS.has(host)) return true;
  return (
    host.endsWith(".example.com") ||
    host.endsWith(".example.org") ||
    host.endsWith(".example.net")
  );
}

function filterHeaders(raw: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!isRecord(raw)) return result;

  for (const [rawName, rawValue] of Object.entries(raw)) {
    if (typeof rawValue !== "string") continue;
    const name = rawName.trim();
    const value = rawValue.trim();
    if (!name || !value) continue;
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) continue;
    if (/[\r\n]/.test(value)) continue;
    const lower = name.toLowerCase();
    if (BLOCKED_HEADERS.has(lower) || lower.startsWith("proxy-")) continue;
    result[name] = value;
  }
  return result;
}

function normalizeSubtitles(
  raw: unknown,
  scraperId: string,
  streamIndex: number,
): StremioSubtitle[] {
  if (!Array.isArray(raw)) return [];
  const result: StremioSubtitle[] = [];

  raw.forEach((track) => {
    if (!isRecord(track)) return;
    const url = trimString(track.url);
    if (!parseHttpUrl(url)) return;
    const language = trimString(track.language) || "en";
    const id =
      result.length === 0
        ? `${scraperId}-${streamIndex}`
        : `${scraperId}-${streamIndex}-${result.length}`;
    result.push({ id, url, lang: language });
  });
  return result;
}

function buildTitle(rawTitle: string, quality: string): string | undefined {
  if (!rawTitle) return quality || undefined;
  if (!quality) return rawTitle;
  const token = quality.split("\u2022")[0]?.trim() ?? "";
  if (token && rawTitle.toLowerCase().includes(token.toLowerCase())) return rawTitle;
  return `${rawTitle} \u2022 ${quality}`;
}

export function normalizeStreamKey(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const origin = parsed.origin.toLowerCase();
    let pathname = parsed.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }
    return `${origin}${pathname}${parsed.search}`;
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

export function mapScraperStreams(
  rawStreams: unknown[],
  options: MapScraperOptions,
): StremioStream[] {
  const mapped: StremioStream[] = [];
  const seenUrls = new Set<string>();
  const scraperName = options.scraperName.trim() || options.scraperId;
  const limit = Math.max(
    0,
    Math.floor(options.perProviderLimit ?? DEFAULT_PER_PROVIDER_LIMIT),
  );

  rawStreams.forEach((raw, streamIndex) => {
    if (!isRecord(raw)) return;
    const stream = raw as NuvioRawStream;

    const rawUrl = trimString(stream.url) || trimString(stream.externalUrl);
    if (!rawUrl) return;
    const parsed = parseHttpUrl(rawUrl);
    if (!parsed || isPlaceholderHost(parsed.hostname)) return;
    if (BLOCKER_URL_PATTERN.test(rawUrl)) return;

    const streamKey = normalizeStreamKey(rawUrl);
    if (seenUrls.has(streamKey)) return;
    seenUrls.add(streamKey);

    const quality = trimString(stream.quality);
    const title = buildTitle(trimString(stream.title) || trimString(stream.name), quality);
    const subtitles = normalizeSubtitles(stream.subtitles, options.scraperId, streamIndex);
    const requestHeaders = filterHeaders(stream.headers);

    const webPage = isWebPage(rawUrl, stream);

    const behaviorHints: NonNullable<StremioStream["behaviorHints"]> = {
      bingeGroup: `${options.scraperId}-${quality || "auto"}`,
    };
    if (!webPage && options.proxyEnabled && Object.keys(requestHeaders).length > 0) {
      behaviorHints.proxyHeaders = { request: requestHeaders };
    }

    mapped.push({
      name: scraperName,
      ...(title ? { title } : {}),
      ...(webPage ? { externalUrl: rawUrl } : { url: rawUrl }),
      behaviorHints,
      ...(!webPage && subtitles.length > 0 ? { subtitles } : {}),
    });
  });

  return sortStreams(mapped).slice(0, limit);
}

const QUALITY_LABELS: Array<[RegExp, number]> = [
  [/(?<![\p{L}\p{N}])8k(?![\p{L}\p{N}])/u, 4320],
  [/(?<![\p{L}\p{N}])4k(?![\p{L}\p{N}])/u, 2160],
  [/(?<![\p{L}\p{N}])uhd(?![\p{L}\p{N}])/u, 2160],
  [/(?<![\p{L}\p{N}])qhd(?![\p{L}\p{N}])/u, 1440],
  [/(?<![\p{L}\p{N}])fhd(?![\p{L}\p{N}])/u, 1080],
];

function qualityValue(value: string): number {
  const lower = value.toLowerCase();
  const pMatch = /(?<!\d)(\d{3,4})p(?:\d{1,3})?(?:fps)?(?![\p{L}\p{N}])/u.exec(lower);
  if (pMatch) return Number(pMatch[1]);
  const bare = /(?<!\d)(4320|2160|1440|1080|720|576|480|360|240)(?![\d\p{L}])/u.exec(
    lower,
  );
  if (bare) return Number(bare[1]);
  for (const [pattern, resolution] of QUALITY_LABELS) {
    if (pattern.test(lower)) return resolution;
  }
  return 0;
}

export function inferQuality(stream: StremioStream): number {
  const sources: string[] = [];
  if (typeof stream.title === "string") {
    sources.push(...stream.title.split("\u2022"));
  }
  if (stream.behaviorHints?.bingeGroup) sources.push(stream.behaviorHints.bingeGroup);
  if (typeof stream.url === "string") sources.push(stream.url);
  if (typeof stream.externalUrl === "string") sources.push(stream.externalUrl);

  let best = 0;
  for (const source of sources) {
    best = Math.max(best, qualityValue(source));
  }
  return best;
}

const FILE_SIZE_UNITS: Record<string, number> = {
  tib: 1024 ** 4,
  tb: 1024 ** 4,
  gib: 1024 ** 3,
  gb: 1024 ** 3,
  mib: 1024 ** 2,
  mb: 1024 ** 2,
};

const FILE_SIZE_PATTERN =
  /(\d+(?:[.,]\d+)?)\s*(TiB|GiB|MiB|TB|GB|MB)(?![a-z0-9]|\s*\/\s*s)/gi;

export function inferFileSizeBytes(stream: StremioStream): number {
  if (typeof stream.title !== "string" || !stream.title) return 0;

  let best = 0;
  for (const match of stream.title.matchAll(FILE_SIZE_PATTERN)) {
    const value = Number.parseFloat(match[1].replace(",", "."));
    if (!Number.isFinite(value)) continue;
    const bytes = value * (FILE_SIZE_UNITS[match[2].toLowerCase()] ?? 0);
    if (bytes > best) best = bytes;
  }
  return Math.round(best);
}

function formatRank(url: string | undefined): number {
  if (!url) return 1;
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return 1;
  }
  if (/\.(?:mp4|mkv|m4v|webm|avi|mov|flv)$/.test(pathname)) return 0;
  if (/\.(?:m3u8|mpd)$/.test(pathname)) return 2;
  return 1;
}

export function sortStreams(streams: StremioStream[]): StremioStream[] {
  if (!Array.isArray(streams)) return [];
  const seen = new Set<string>();
  const unique: Array<{ stream: StremioStream; index: number }> = [];

  streams.forEach((stream, index) => {
    if (!stream) return;
    const targetUrl = stream.url || stream.externalUrl;
    if (typeof targetUrl !== "string" || !targetUrl) return;
    const streamKey = normalizeStreamKey(targetUrl);
    if (seen.has(streamKey)) return;
    seen.add(streamKey);
    unique.push({ stream, index });
  });

  unique.sort((a, b) => {
    const aIsExt = a.stream.externalUrl ? 1 : 0;
    const bIsExt = b.stream.externalUrl ? 1 : 0;
    if (aIsExt !== bIsExt) return aIsExt - bIsExt;

    const qualityDiff = inferQuality(b.stream) - inferQuality(a.stream);
    if (qualityDiff !== 0) return qualityDiff;
    const formatDiff = formatRank(a.stream.url) - formatRank(b.stream.url);
    if (formatDiff !== 0) return formatDiff;
    return a.index - b.index;
  });

  return unique.map((entry) => entry.stream);
}
