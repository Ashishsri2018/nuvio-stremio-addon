import { describe, expect, it } from "vitest";
import type { CinemetaClient } from "../src/cinemeta/client.js";
import type { SnapshotManager } from "../src/nuvio/snapshot.js";
import { StreamPipeline } from "../src/nuvio/pipeline.js";
import type { LoadedScraper, NuvioSnapshot } from "../src/types.js";
import { makeEntry, silentLogger, testConfig } from "./helpers.js";

function makeScraper(
  id: string,
  supportedTypes: string[],
  getStreams: LoadedScraper["getStreams"],
  name = `${id} scraper`,
): LoadedScraper {
  return {
    entry: makeEntry({ id, name, supportedTypes }),
    settings: {},
    getStreams,
  };
}

function fakeSnapshots(snapshot: NuvioSnapshot | null) {
  const calls = { ensure: 0 };
  const manager = {
    ensure: async () => {
      calls.ensure += 1;
      return snapshot;
    },
  } as unknown as SnapshotManager;
  return { manager, calls };
}

function fakeCinemeta(resolve: (type: "movie" | "series", imdbId: string) => number | null) {
  const calls: Array<{ type: string; imdbId: string }> = [];
  const client = {
    resolveTmdbId: async (type: "movie" | "series", imdbId: string) => {
      calls.push({ type, imdbId });
      return resolve(type, imdbId);
    },
  } as unknown as CinemetaClient;
  return { client, calls };
}

function snapshotWith(scrapers: LoadedScraper[]): NuvioSnapshot {
  return { sha: "abcdef1234567890", fetchedAt: Date.now(), scrapers };
}

describe("StreamPipeline", () => {
  it("resolves the TMDB id and calls movie scrapers with direct streams", async () => {
    const calls: Array<[number, string, number | undefined, number | undefined]> = [];
    const scraper = makeScraper("alpha", ["movie"], async (...args) => {
      calls.push(args);
      return [
        {
          url: "https://cdn.test/movie.mp4",
          quality: "1080p",
          headers: { Referer: "https://ref.test/" },
        },
      ];
    });
    const tvOnly = makeScraper("tvonly", ["tv"], async () => {
      throw new Error("tv scraper should not run for movies");
    });

    const config = await testConfig({ PROXY_ENABLED: "true" });
    const { manager } = fakeSnapshots(snapshotWith([scraper, tvOnly]));
    const { client, calls: cinemetaCalls } = fakeCinemeta(() => 603);
    const pipeline = new StreamPipeline({
      config,
      logger: silentLogger(),
      snapshots: manager,
      cinemeta: client,
    });

    const streams = await pipeline.handle({ type: "movie", imdbId: "tt0133093" });

    expect(cinemetaCalls).toEqual([{ type: "movie", imdbId: "tt0133093" }]);
    expect(calls).toEqual([[603, "movie", undefined, undefined]]);
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      name: "alpha scraper",
      url: "https://cdn.test/movie.mp4",
      title: "1080p",
      behaviorHints: {
        bingeGroup: "alpha-1080p",
        proxyHeaders: { request: { Referer: "https://ref.test/" } },
      },
    });
  });

  it("passes tv plus season and episode for series", async () => {
    const calls: Array<[number, string, number | undefined, number | undefined]> = [];
    const scraper = makeScraper("alpha", ["tv"], async (...args) => {
      calls.push(args);
      return [];
    });

    const config = await testConfig();
    const { manager } = fakeSnapshots(snapshotWith([scraper]));
    const { client } = fakeCinemeta(() => 1399);
    const pipeline = new StreamPipeline({
      config,
      logger: silentLogger(),
      snapshots: manager,
      cinemeta: client,
    });

    await pipeline.handle({
      type: "series",
      imdbId: "tt0944947",
      season: 2,
      episode: 3,
    });

    expect(calls).toEqual([[1399, "tv", 2, 3]]);
  });

  it("returns partial results when a scraper fails", async () => {
    const good = makeScraper("good", ["movie"], async () => [
      { url: "https://cdn.test/good.mp4", quality: "720p" },
    ]);
    const bad = makeScraper("bad", ["movie"], async () => {
      throw new Error("upstream exploded");
    });

    const config = await testConfig();
    const { manager } = fakeSnapshots(snapshotWith([good, bad]));
    const { client } = fakeCinemeta(() => 603);
    const pipeline = new StreamPipeline({
      config,
      logger: silentLogger(),
      snapshots: manager,
      cinemeta: client,
    });

    const streams = await pipeline.handle({ type: "movie", imdbId: "tt0133093" });
    expect(streams.map((stream) => stream.url)).toEqual([
      "https://cdn.test/good.mp4",
    ]);
  });

  it("stops at the global deadline and keeps finished results", async () => {
    const fast = makeScraper("fast", ["movie"], async () => [
      { url: "https://cdn.test/fast.mp4", quality: "1080p" },
    ]);
    const slow = makeScraper(
      "slow",
      ["movie"],
      () => new Promise(() => undefined),
    );

    const config = await testConfig({ GLOBAL_DEADLINE_MS: "2000" });
    const { manager } = fakeSnapshots(snapshotWith([slow, fast]));
    const { client } = fakeCinemeta(() => 603);
    const pipeline = new StreamPipeline({
      config,
      logger: silentLogger(),
      snapshots: manager,
      cinemeta: client,
    });

    const startedAt = Date.now();
    const streams = await pipeline.handle({ type: "movie", imdbId: "tt0133093" });
    expect(streams.map((stream) => stream.url)).toEqual([
      "https://cdn.test/fast.mp4",
    ]);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it("returns nothing when the TMDB id cannot be resolved", async () => {
    const config = await testConfig();
    const { manager, calls } = fakeSnapshots(snapshotWith([]));
    const { client } = fakeCinemeta(() => null);
    const pipeline = new StreamPipeline({
      config,
      logger: silentLogger(),
      snapshots: manager,
      cinemeta: client,
    });

    await expect(
      pipeline.handle({ type: "movie", imdbId: "tt0000000" }),
    ).resolves.toEqual([]);
    expect(calls.ensure).toBe(0);
  });

  it("returns nothing when no snapshot is available", async () => {
    const config = await testConfig();
    const { manager } = fakeSnapshots(null);
    const { client } = fakeCinemeta(() => 603);
    const pipeline = new StreamPipeline({
      config,
      logger: silentLogger(),
      snapshots: manager,
      cinemeta: client,
    });

    await expect(
      pipeline.handle({ type: "movie", imdbId: "tt0133093" }),
    ).resolves.toEqual([]);
  });

  it("caches identical requests", async () => {
    let calls = 0;
    const scraper = makeScraper("alpha", ["movie"], async () => {
      calls += 1;
      return [{ url: "https://cdn.test/a.mp4", quality: "1080p" }];
    });

    const config = await testConfig({ STREAM_CACHE_TTL_MS: "60000" });
    const { manager } = fakeSnapshots(snapshotWith([scraper]));
    const { client } = fakeCinemeta(() => 603);
    const pipeline = new StreamPipeline({
      config,
      logger: silentLogger(),
      snapshots: manager,
      cinemeta: client,
    });

    const request = { type: "movie" as const, imdbId: "tt0133093" };
    const first = await pipeline.handle(request);
    const second = await pipeline.handle(request);
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  it("returns nothing immediately when the request is already aborted", async () => {
    const config = await testConfig();
    const { manager } = fakeSnapshots(snapshotWith([]));
    const { client, calls } = fakeCinemeta(() => 603);
    const pipeline = new StreamPipeline({
      config,
      logger: silentLogger(),
      snapshots: manager,
      cinemeta: client,
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      pipeline.handle({ type: "movie", imdbId: "tt0133093" }, controller.signal),
    ).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it("omits proxy headers when the proxy is disabled", async () => {
    const scraper = makeScraper("alpha", ["movie"], async () => [
      {
        url: "https://cdn.test/a.mp4",
        quality: "1080p",
        headers: { Referer: "https://ref.test/" },
      },
    ]);

    const config = await testConfig({ PROXY_ENABLED: "false" });
    const { manager } = fakeSnapshots(snapshotWith([scraper]));
    const { client } = fakeCinemeta(() => 603);
    const pipeline = new StreamPipeline({
      config,
      logger: silentLogger(),
      snapshots: manager,
      cinemeta: client,
    });

    const streams = await pipeline.handle({ type: "movie", imdbId: "tt0133093" });
    expect(streams[0]?.behaviorHints).toEqual({ bingeGroup: "alpha-1080p" });
  });
});
