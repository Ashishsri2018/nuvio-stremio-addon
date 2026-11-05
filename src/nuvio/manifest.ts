import type { NuvioManifest, NuvioScraperEntry } from "../types.js";

const SAFE_ID = /^[A-Za-z0-9_.-]+$/;
const PROVIDER_FILE = /^providers\/[A-Za-z0-9_.-]+\.js$/;
const MAX_SCRAPERS = 200;

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function parseNuvioManifest(bytes: Buffer): NuvioManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(bytes.toString("utf8")));
  } catch {
    throw new ManifestError("manifest.json is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new ManifestError("manifest.json must contain an object");
  }
  if (!Array.isArray(parsed.scrapers)) {
    throw new ManifestError("manifest.json must contain a scrapers array");
  }
  if (parsed.scrapers.length > MAX_SCRAPERS) {
    throw new ManifestError(`manifest.json has too many scrapers (${parsed.scrapers.length})`);
  }

  const seen = new Set<string>();
  const scrapers: NuvioScraperEntry[] = [];
  for (const raw of parsed.scrapers) {
    if (!isRecord(raw)) {
      throw new ManifestError("manifest.json contains a non-object scraper");
    }
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!SAFE_ID.test(id)) {
      throw new ManifestError("manifest.json contains a scraper with an invalid id");
    }
    if (seen.has(id)) {
      throw new ManifestError(`manifest.json contains duplicate scraper ${id}`);
    }
    seen.add(id);

    const filename = typeof raw.filename === "string" ? raw.filename.trim() : "";
    if (!PROVIDER_FILE.test(filename)) {
      throw new ManifestError(`manifest.json scraper ${id} has an invalid filename`);
    }

    const supported = stringArray(raw.supportedTypes);
    scrapers.push({
      id,
      name: optionalString(raw.name) ?? id,
      description: optionalString(raw.description),
      version: optionalString(raw.version) ?? "0.0.0",
      author: optionalString(raw.author),
      supportedTypes: supported.length > 0 ? supported : ["movie", "tv"],
      filename,
      enabled: raw.enabled !== false,
      formats: stringArray(raw.formats),
      contentLanguage: stringArray(raw.contentLanguage),
      hasSettings: raw.hasSettings === true,
      disabledPlatforms: stringArray(raw.disabledPlatforms),
    });
  }

  return {
    name: optionalString(parsed.name) ?? "Nuvio",
    version: optionalString(parsed.version) ?? "0.0.0",
    scrapers,
  };
}

export function selectScrapers(
  manifest: NuvioManifest,
  disabledIds: Iterable<string>,
): NuvioScraperEntry[] {
  const disabled = new Set(disabledIds);
  return manifest.scrapers.filter(
    (scraper) => scraper.enabled && !disabled.has(scraper.id),
  );
}
