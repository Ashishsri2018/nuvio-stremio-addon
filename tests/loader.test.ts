import { describe, expect, it } from "vitest";
import { loadScraper, scraperSupports } from "../src/nuvio/loader.js";
import { makeEntry } from "./helpers.js";

const PROVIDER = `
const cheerio = require("cheerio");
const TMDB_KEY = (typeof TMDB_API_KEY !== "undefined" && TMDB_API_KEY) || "fallback";
const MIN_SECONDS = SCRAPER_SETTINGS.minSeconds || "default";
const HAS_HTML = typeof cheerio.load === "function";

async function onSettings() {
  return [{ type: "select", key: "minSeconds", label: "Min", defaultValue: "360" }];
}

async function getStreams(tmdbId, mediaType, season, episode) {
  return [{
    name: "Demo",
    title: "Demo stream",
    url: "https://cdn.test/video.mp4",
    quality: "1080p",
    headers: { Referer: "https://site.test/" },
    subtitles: [{ url: "https://cdn.test/subs.vtt", language: "en" }],
    meta: { tmdbId, mediaType, season, episode, key: TMDB_KEY, minSeconds: MIN_SECONDS, hasHtml: HAS_HTML }
  }];
}

module.exports = { getStreams, onSettings };
`;

async function load(envSettings: Record<string, unknown> = {}) {
  return loadScraper({
    entry: makeEntry(),
    code: PROVIDER,
    tmdbApiKey: "env-key",
    envSettings,
    fetchTimeoutMs: 1000,
  });
}

describe("loadScraper", () => {
  it("injects TMDB key, settings overrides, cheerio, and args", async () => {
    const scraper = await load({ minSeconds: "900" });
    expect(scraper.settings).toEqual({ minSeconds: "900" });
    const streams = (await scraper.getStreams(603, "movie")) as Array<{
      meta: Record<string, unknown>;
    }>;
    expect(streams[0]?.meta).toMatchObject({
      tmdbId: 603,
      mediaType: "movie",
      season: undefined,
      episode: undefined,
      key: "env-key",
      minSeconds: "900",
      hasHtml: true,
    });
  });

  it("applies onSettings defaults when there are no overrides", async () => {
    const scraper = await load();
    expect(scraper.settings).toEqual({ minSeconds: "360" });
    const streams = (await scraper.getStreams(1399, "tv", 1, 2)) as Array<{
      meta: Record<string, unknown>;
    }>;
    expect(streams[0]?.meta).toMatchObject({
      tmdbId: 1399,
      mediaType: "tv",
      season: 1,
      episode: 2,
      minSeconds: "360",
    });
  });

  it("rejects modules without getStreams", async () => {
    await expect(
      loadScraper({
        entry: makeEntry(),
        code: "module.exports = { onSettings: async () => [] };",
        tmdbApiKey: null,
        envSettings: {},
        fetchTimeoutMs: 1000,
      }),
    ).rejects.toThrow(/getStreams/);
  });

  it("rejects unknown require targets", async () => {
    await expect(
      loadScraper({
        entry: makeEntry(),
        code: 'const fs = require("fs"); module.exports = { getStreams: async () => [] };',
        tmdbApiKey: null,
        envSettings: {},
        fetchTimeoutMs: 1000,
      }),
    ).rejects.toThrow(/not available/);
  });

  it("filters supported types", async () => {
    const scraper = await load();
    expect(scraperSupports(scraper, "movie")).toBe(true);
    expect(scraperSupports(scraper, "series")).toBe(true);
    const movieOnly = { ...scraper, entry: makeEntry({ supportedTypes: ["movie"] }) };
    expect(scraperSupports(movieOnly, "series")).toBe(false);
  });
});
