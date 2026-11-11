import { describe, expect, it } from "vitest";
import {
  inferQuality,
  mapScraperStreams,
  sortStreams,
  type MapScraperOptions,
} from "../src/addon/mapStreams.js";
import { isWebPage } from "../src/addon/urlClassifier.js";

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

  it("allows up to 300 streams per provider by default, keeping all 30 unique streams", () => {
    const raw = Array.from({ length: 30 }, (_, index) => ({
      url: `https://cdn.test/${index}.mp4`,
      quality: `${index % 4 === 0 ? "1080p" : "720p"}`,
    }));
    const streams = mapScraperStreams(raw, options());
    expect(streams).toHaveLength(30);

    const capped = mapScraperStreams(raw, options({ perProviderLimit: 5 }));
    expect(capped).toHaveLength(5);
  });

  it("removes duplicate URLs pointing to the same file", () => {
    const streams = mapScraperStreams(
      [
        { url: "https://cdn.test/movie.mp4", quality: "1080p" },
        { url: "https://CDN.TEST/movie.mp4#preview", quality: "1080p" },
        { url: "https://cdn.test/movie.mp4/", quality: "1080p" },
        { url: "https://cdn.test/other.mp4", quality: "720p" },
      ],
      options(),
    );
    expect(streams).toHaveLength(2);
    expect(streams[0]?.url).toBe("https://cdn.test/movie.mp4");
    expect(streams[1]?.url).toBe("https://cdn.test/other.mp4");
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

  it("maps web pages and embed URLs to externalUrl and omits url and proxy headers", () => {
    const streams = mapScraperStreams(
      [
        {
          title: "MultiMovies Embed",
          url: "https://screenscape.me/embed?tmdb=550",
          quality: "1080p",
          headers: { Referer: "https://screenscape.me" },
        },
        {
          title: "Movie Page",
          url: "https://moviesapi.to/movie/550",
          quality: "720p",
        },
        {
          title: "Bot Link",
          url: "https://t.me/streambot?start=123",
        },
      ],
      options(),
    );

    expect(streams).toHaveLength(3);
    expect(streams[0]?.externalUrl).toBe("https://screenscape.me/embed?tmdb=550");
    expect(streams[0]?.url).toBeUndefined();
    expect(streams[0]?.behaviorHints?.proxyHeaders).toBeUndefined();

    expect(streams[1]?.externalUrl).toBe("https://moviesapi.to/movie/550");
    expect(streams[1]?.url).toBeUndefined();

    expect(streams[2]?.externalUrl).toBe("https://t.me/streambot?start=123");
    expect(streams[2]?.url).toBeUndefined();
  });

  it("maps zip archives to externalUrl", () => {
    const streams = mapScraperStreams(
      [
        {
          title: "Show Episode Archive",
          url: "https://cdn.test/episode.mkv.zip",
        },
      ],
      options(),
    );
    expect(streams).toHaveLength(1);
    expect(streams[0]?.externalUrl).toBe("https://cdn.test/episode.mkv.zip");
    expect(streams[0]?.url).toBeUndefined();
  });

  it("drops rate-limit slowdown blocker URLs", () => {
    const streams = mapScraperStreams(
      [
        {
          url: "https://st.111477.xyz/slowdown",
          title: "Slow Down",
        },
        {
          url: "https://cdn.test/valid.mp4",
          title: "Valid Stream",
        },
      ],
      options(),
    );
    expect(streams).toHaveLength(1);
    expect(streams[0]?.url).toBe("https://cdn.test/valid.mp4");
  });

  it("accepts provider-tagged externalUrl directly", () => {
    const streams = mapScraperStreams(
      [
        {
          title: "Provider Tagged Web Link",
          externalUrl: "https://custom-host.test/watch/123",
          quality: "1080p",
        },
      ],
      options(),
    );
    expect(streams).toHaveLength(1);
    expect(streams[0]?.externalUrl).toBe("https://custom-host.test/watch/123");
    expect(streams[0]?.url).toBeUndefined();
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

  it("prioritizes direct video streams over external web pages regardless of quality", () => {
    const streams = sortStreams([
      { name: "embed-4k", externalUrl: "https://screenscape.me/embed?tmdb=1", title: "4K Embed" },
      { name: "direct-1080p", url: "https://cdn.test/stream.m3u8", title: "1080p Direct" },
      { name: "direct-720p", url: "https://cdn.test/stream.mp4", title: "720p Direct" },
      { name: "embed-1080p", externalUrl: "https://moviesapi.to/movie/1", title: "1080p External" },
    ]);

    expect(streams.map((s) => s.name)).toEqual([
      "direct-1080p",
      "direct-720p",
      "embed-4k",
      "embed-1080p",
    ]);
  });

  it("dedupes streams across url and externalUrl, normalizing same-file variations", () => {
    const streams = sortStreams([
      { name: "first", externalUrl: "https://moviesapi.to/movie/1" },
      { name: "dup", externalUrl: "https://MOVIESAPI.TO/movie/1#watch" },
    ]);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.name).toBe("first");
  });
});

describe("isWebPage", () => {
  it("identifies direct video streams", () => {
    expect(isWebPage("https://cdn.test/video.mp4")).toBe(false);
    expect(isWebPage("https://cdn.test/video.m3u8")).toBe(false);
    expect(isWebPage("https://cdn.test/video.mpd")).toBe(false);
    expect(isWebPage("https://cdn.test/video.mkv")).toBe(false);
    expect(isWebPage("https://video-downloads.googleusercontent.com/xyz")).toBe(false);
    expect(isWebPage("https://pub-123.r2.cloudflarestorage.com/media")).toBe(false);
  });

  it("identifies web pages and embed targets", () => {
    expect(isWebPage("https://screenscape.me/embed?tmdb=1")).toBe(true);
    expect(isWebPage("https://moviesapi.to/movie/1234")).toBe(true);
    expect(isWebPage("https://site.test/video.html")).toBe(true);
    expect(isWebPage("https://site.test/video.php?id=1")).toBe(true);
    expect(isWebPage("https://site.test/download.zip")).toBe(true);
    expect(isWebPage("https://t.me/stream_bot")).toBe(true);
    expect(isWebPage("https://site.test/watch/123", { name: "Server [Embed]" })).toBe(true);
  });
});
