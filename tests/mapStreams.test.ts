import { describe, expect, it } from "vitest";
import {
  inferQuality,
  mapScraperStreams,
  sortStreams,
  type MapScraperOptions,
} from "../src/addon/mapStreams.js";

function options(overrides: Partial<MapScraperOptions> = {}): MapScraperOptions {
  return {
    scraperId: "alpha",
    scraperName: "Alpha Scraper",
    proxyEnabled: true,
    ...overrides,
  };
}

describe("mapScraperStreams", () => {
  it("maps a Nuvio stream to a direct Stremio stream", () => {
    const streams = mapScraperStreams(
      [
        {
          name: "ignored",
          title: "Alpha",
          url: "https://cdn.test/a.m3u8",
          quality: "1080p",
          headers: {
            Referer: "https://site.test/",
            "X-Safe": "1",
            Connection: "keep-alive",
            "Proxy-Authorization": "secret",
            "Bad Header": "x",
            "X-CRLF": "a\r\nb",
          },
          subtitles: [
            { url: "https://cdn.test/subs.vtt", language: "es" },
            { url: "javascript:alert(1)", language: "en" },
            { url: "https://cdn.test/second.vtt" },
          ],
        },
      ],
      options(),
    );

    expect(streams).toHaveLength(1);
    expect(streams[0]).toEqual({
      name: "Alpha Scraper",
      title: "Alpha \u2022 1080p",
      url: "https://cdn.test/a.m3u8",
      behaviorHints: {
        bingeGroup: "alpha-1080p",
        proxyHeaders: {
          request: { Referer: "https://site.test/", "X-Safe": "1" },
        },
      },
      subtitles: [
        { id: "alpha-0", url: "https://cdn.test/subs.vtt", lang: "es" },
        { id: "alpha-0-1", url: "https://cdn.test/second.vtt", lang: "en" },
      ],
    });
  });

  it("omits proxy headers when the proxy is disabled", () => {
    const streams = mapScraperStreams(
      [
        {
          url: "https://cdn.test/a.mp4",
          quality: "720p",
          headers: { Referer: "https://site.test/" },
        },
      ],
      options({ proxyEnabled: false }),
    );

    expect(streams).toHaveLength(1);
    expect(streams[0]?.behaviorHints).toEqual({ bingeGroup: "alpha-720p" });
    expect(streams[0]?.title).toBe("720p");
  });

  it("rejects magnets, unsafe protocols, placeholders, and duplicates", () => {
    const streams = mapScraperStreams(
      [
        { url: "magnet:?xt=urn:btih:abc" },
        { url: "ftp://cdn.test/a.mp4" },
        { url: "https://example.com/a.mp4" },
        { url: "https://sub.example.org/a.mp4" },
        { url: "http://127.0.0.1/a.mp4" },
        { url: "not a url" },
        {},
        { url: "https://cdn.test/ok.mp4" },
        { url: "https://cdn.test/ok.mp4", quality: "duplicate" },
      ],
      options(),
    );

    expect(streams).toHaveLength(1);
    expect(streams[0]?.url).toBe("https://cdn.test/ok.mp4");
  });

  it("sorts by quality, preferring direct files over HLS", () => {
    const streams = mapScraperStreams(
      [
        { url: "https://cdn.test/720.m3u8", quality: "720p" },
        { url: "https://cdn.test/1080.m3u8", quality: "1080p" },
        { url: "https://cdn.test/1080.mp4", quality: "1080p" },
        { url: "https://cdn.test/2160.mkv", quality: "4K" },
      ],
      options(),
    );

    expect(streams.map((stream) => stream.url)).toEqual([
      "https://cdn.test/2160.mkv",
      "https://cdn.test/1080.mp4",
      "https://cdn.test/1080.m3u8",
      "https://cdn.test/720.m3u8",
    ]);
  });

  it("caps streams per provider", () => {
    const raw = Array.from({ length: 30 }, (_, index) => ({
      url: `https://cdn.test/${index}.mp4`,
      quality: `${index % 4 === 0 ? "1080p" : "720p"}`,
    }));
    const streams = mapScraperStreams(raw, options({ perProviderLimit: 5 }));
    expect(streams).toHaveLength(5);
  });

  it("leaves the stream url untouched", () => {
    const streams = mapScraperStreams(
      [{ url: "https://provider.test/hls/master.m3u8?token=abc", quality: "1080p" }],
      options(),
    );
    expect(streams[0]?.url).toBe(
      "https://provider.test/hls/master.m3u8?token=abc",
    );
  });
});

describe("inferQuality", () => {
  it("reads quality tokens from titles and urls", () => {
    expect(inferQuality({ name: "x", title: "Movie \u2022 2160p", url: "https://t/a" })).toBe(
      2160,
    );
    expect(inferQuality({ name: "x", url: "https://t/movie.1080p.mp4" })).toBe(1080);
    expect(inferQuality({ name: "x", url: "https://t/a.mp4" })).toBe(0);
  });
});

describe("sortStreams", () => {
  it("dedupes by url and keeps the first occurrence", () => {
    const streams = sortStreams([
      { name: "a", url: "https://cdn.test/a.mp4", title: "720p" },
      { name: "b", url: "https://cdn.test/a.mp4", title: "2160p" },
      { name: "b", url: "https://cdn.test/b.mp4", title: "1080p" },
    ]);
    expect(streams.map((stream) => stream.name)).toEqual(["b", "a"]);
  });
});
