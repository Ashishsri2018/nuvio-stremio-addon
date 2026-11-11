import { z } from "zod";
import { inferFileSizeBytes, inferQuality } from "./mapStreams.js";
import type { StremioStream, StremioSubtitle } from "../types.js";

const USER_CONFIG_VERSION = 1;
const MAX_SUBTITLE_LANGS = 20;
const SUBTITLE_LANG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

export interface UserConfig {
  maxRes: number | null;
  minRes: number | null;
  includeUnknown: boolean;
  maxSizeMB: number | null;
  includeUnknownSize: boolean;
  subtitleLangs: string[];
}

export const DEFAULT_USER_CONFIG: UserConfig = {
  maxRes: null,
  minRes: null,
  includeUnknown: true,
  maxSizeMB: null,
  includeUnknownSize: true,
  subtitleLangs: [],
};

function normalizeSubtitleLangs(values: readonly string[] | undefined): string[] {
  const result: string[] = [];
  for (const raw of values ?? []) {
    const lang = raw.trim().toLowerCase().replace(/_/g, "-");
    if (!lang || !SUBTITLE_LANG.test(lang) || result.includes(lang)) continue;
    result.push(lang);
    if (result.length >= MAX_SUBTITLE_LANGS) break;
  }
  return result;
}

const schema = z
  .object({
    v: z.literal(USER_CONFIG_VERSION).optional(),
    maxRes: z.number().int().min(144).max(4320).nullable().optional(),
    minRes: z.number().int().min(144).max(4320).nullable().optional(),
    includeUnknown: z.boolean().optional(),
    maxSizeMB: z.number().int().min(1).max(1_000_000).nullable().optional(),
    includeUnknownSize: z.boolean().optional(),
    subtitleLangs: z
      .array(z.string().trim().regex(SUBTITLE_LANG))
      .max(MAX_SUBTITLE_LANGS)
      .optional(),
  })
  .refine(
    (value) => {
      const max = value.maxRes ?? null;
      const min = value.minRes ?? null;
      return max === null || min === null || min <= max;
    },
    { message: "minRes must not exceed maxRes" },
  );

export function encodeUserConfig(config: UserConfig): string {
  const payload: Record<string, unknown> = { v: USER_CONFIG_VERSION };
  if (config.maxRes !== null) payload.maxRes = config.maxRes;
  if (config.minRes !== null) payload.minRes = config.minRes;
  if (!config.includeUnknown) payload.includeUnknown = false;
  if (config.maxSizeMB != null) payload.maxSizeMB = config.maxSizeMB;
  if (config.includeUnknownSize === false) payload.includeUnknownSize = false;
  const subtitleLangs = normalizeSubtitleLangs(config.subtitleLangs);
  if (subtitleLangs.length > 0) payload.subtitleLangs = subtitleLangs;
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function parseUserConfig(segment: string | undefined): UserConfig {
  if (!segment) return DEFAULT_USER_CONFIG;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return DEFAULT_USER_CONFIG;
  }

  const parsed = schema.safeParse(decoded);
  if (!parsed.success) return DEFAULT_USER_CONFIG;

  return {
    maxRes: parsed.data.maxRes ?? null,
    minRes: parsed.data.minRes ?? null,
    includeUnknown: parsed.data.includeUnknown ?? true,
    maxSizeMB: parsed.data.maxSizeMB ?? null,
    includeUnknownSize: parsed.data.includeUnknownSize ?? true,
    subtitleLangs: normalizeSubtitleLangs(parsed.data.subtitleLangs),
  };
}

const LANGUAGE_ALIASES: Record<string, string> = {
  english: "en",
  urdu: "ur",
  arabic: "ar",
  bengali: "bn",
  indonesian: "id",
  spanish: "es",
  french: "fr",
  portuguese: "pt",
  brazilian: "pt-br",
  "brazilian portuguese": "pt-br",
  turkish: "tr",
  chinese: "zh",
  croatian: "hr",
  danish: "da",
  filipino: "fil",
  tagalog: "fil",
  finnish: "fi",
  thai: "th",
  german: "de",
  hindi: "hi",
  japanese: "ja",
  korean: "ko",
  tamil: "ta",
  telugu: "te",
  malayalam: "ml",
  punjabi: "pa",
  marathi: "mr",
  gujarati: "gu",
  russian: "ru",
  italian: "it",
  dutch: "nl",
  polish: "pl",
  swedish: "sv",
  norwegian: "no",
  greek: "el",
  hebrew: "he",
  czech: "cs",
  hungarian: "hu",
  romanian: "ro",
  ukrainian: "uk",
  vietnamese: "vi",
  malay: "ms",
  persian: "fa",
  farsi: "fa",
  swahili: "sw",
  afrikaans: "af",
  serbian: "sr",
  bulgarian: "bg",
  slovak: "sk",
  slovenian: "sl",
  lithuanian: "lt",
  latvian: "lv",
  estonian: "et",
  catalan: "ca",
  icelandic: "is",
  irish: "ga",
  welsh: "cy",
  albanian: "sq",
  bosnian: "bs",
  macedonian: "mk",
  nepali: "ne",
  sinhala: "si",
  khmer: "km",
  lao: "lo",
  burmese: "my",
  georgian: "ka",
  armenian: "hy",
  azerbaijani: "az",
  kazakh: "kk",
  uzbek: "uz",
  mongolian: "mn",
  amharic: "am",
  somali: "so",
  yoruba: "yo",
  hausa: "ha",
  zulu: "zu",
  xhosa: "xh",
};

function normalizeLanguage(value: string): string {
  const lang = value.trim().toLowerCase().replace(/_/g, "-");
  if (!lang) return "";
  return LANGUAGE_ALIASES[lang] ?? lang;
}

function languageMatches(trackLang: string, wanted: readonly string[]): boolean {
  const lang = normalizeLanguage(trackLang);
  if (!lang) return false;
  const base = lang.split("-")[0];
  return wanted.some((candidate) => {
    const wantedLang = normalizeLanguage(candidate);
    const wantedBase = wantedLang.split("-")[0];
    return lang === wantedLang || base === wantedBase;
  });
}

export function filterSubtitles(
  subtitles: readonly StremioSubtitle[] | undefined,
  langs: readonly string[],
): StremioSubtitle[] {
  const wanted = normalizeSubtitleLangs(langs);
  if (wanted.length === 0) return subtitles ? [...subtitles] : [];
  return (subtitles ?? []).filter((track) =>
    languageMatches(track.lang, wanted),
  );
}

export function filterStreams(
  streams: StremioStream[],
  config: UserConfig,
): StremioStream[] {
  const { maxRes, minRes, includeUnknown } = config;
  const maxSizeMB = config.maxSizeMB ?? null;
  const includeUnknownSize = config.includeUnknownSize ?? true;
  const filterQuality = maxRes !== null || minRes !== null || !includeUnknown;
  const filterSize = maxSizeMB !== null;

  if (!filterQuality && !filterSize) return streams;

  let result = filterQuality
    ? streams.filter((stream) => {
        const quality = inferQuality(stream);
        if (quality === 0) return includeUnknown;
        if (maxRes !== null && quality > maxRes) return false;
        if (minRes !== null && quality < minRes) return false;
        return true;
      })
    : streams;

  if (filterSize) {
    const limitBytes = maxSizeMB * 1024 * 1024;
    result = result.filter((stream) => {
      const size = inferFileSizeBytes(stream);
      if (size === 0) return includeUnknownSize;
      return size <= limitBytes;
    });
  }

  return result;
}
