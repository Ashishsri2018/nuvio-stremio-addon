import { describe, expect, it } from "vitest";
import type { CinemetaClient } from "../src/cinemeta/client.js";
import type { SnapshotManager } from "../src/nuvio/snapshot.js";
import { StreamPipeline } from "../src/nuvio/pipeline.js";
import type { LoadedScraper, NuvioSnapshot } from "../src/types.js";
import { makeEntry, recordingLogger, silentLogger, testConfig } from "./helpers.js";

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

  it("uses TMDB ids directly without calling Cinemeta", async () => {
    const calls: Array<[number, string, number | undefined, number | undefined]> = [];
    const scraper = makeScraper("alpha", ["movie", "tv"], async (...args) => {
      calls.push(args);
      return [];
    });

    const config = await testConfig();
    const { manager } = fakeSnapshots(snapshotWith([scraper]));
    const { client, calls: cinemetaCalls } = fakeCinemeta(() => 1);
    const { logger, events } = recordingLogger();
    const pipeline = new StreamPipeline({
      config,
      logger,
      snapshots: manager,
      cinemeta: client,
    });

    await pipeline.handle({ type: "movie", tmdbId: 550 });
    await pipeline.handle({ type: "series", tmdbId: 1399, season: 2, episode: 3 });

    expect(cinemetaCalls).toEqual([]);
    expect(calls).toEqual([
      [550, "movie", undefined, undefined],
      [1399, "tv", 2, 3],
    ]);

    const summaries = events.filter(
      (entry) => entry.event === "nuvio_streams_resolved",
    );
    expect(summaries[0]).toMatchObject({
      contentId: "tmdb:550",
      imdbId: null,
      tmdbId: 550,
      outcome: "ok",
    });
    expect(summaries[1]).toMatchObject({
      contentId: "tmdb:1399",
      imdbId: null,
      tmdbId: 1399,
      season: 2,
      episode: 3,
      outcome: "ok",
    });
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

  it("times out slow providers without waiting for the global deadline", async () => {
    const fast = makeScraper("fast", ["movie"], async () => [
      { url: "https://cdn.test/fast.mp4", quality: "1080p" },
    ]);
    const slow = makeScraper(
      "slow",
      ["movie"],
      () => new Promise(() => undefined),
    );

    const config = await testConfig({
      GLOBAL_DEADLINE_MS: "10000",
      SCRAPER_TIMEOUT_MS: "1000",
    });
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
    expect(Date.now() - startedAt).toBeLessThan(3_000);
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

  it("reports canonical request and stream-cache metrics", async () => {
    const scraper = makeScraper("alpha", ["movie"], async () => [
      { url: "https://cdn.test/metrics.mp4", quality: "1080p" },
    ]);

    const config = await testConfig({
      STREAM_CACHE_TTL_MS: "60000",
      STREAM_PARTIAL_CACHE_TTL_MS: "30000",
    });
    const { manager } = fakeSnapshots(snapshotWith([scraper]));
    const { client } = fakeCinemeta(() => 603);
    const pipeline = new StreamPipeline({
      config,
      logger: silentLogger(),
      snapshots: manager,
      cinemeta: client,
    });

    const request = { type: "movie" as const, imdbId: "tt0133093" };
    await pipeline.handle(request);
    await pipeline.handle(request);

    expect(pipeline.getMetrics()).toEqual({
      requests: 2,
      cacheHits: 1,
      cacheMisses: 1,
      emptyResults: 0,
      deadlineHits: 0,
      settleHits: 0,
      providerFailures: 0,
    });
    expect(pipeline.getCacheStats()).toEqual({
      enabled: true,
      hits: 1,
      misses: 1,
      coalesced: 0,
      sets: 1,
      evictions: 0,
      expired: 0,
      size: 1,
      maxEntries: 500,
      ttlMs: 60000,
      partialTtlMs: 30000,
    });
    expect(pipeline.getMetadataCacheStats()).toBeNull();
  });

  it("does not cache empty results", async () => {
    let calls = 0;
    const scraper = makeScraper("empty", ["movie"], async () => {
      calls += 1;
      return [];
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
    await expect(pipeline.handle(request)).resolves.toEqual([]);
    await expect(pipeline.handle(request)).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  it("caches deadline-truncated results at the partial ttl", async () => {
    let calls = 0;
    const fast = makeScraper("fast", ["movie"], async () => {
      calls += 1;
      return [{ url: "https://cdn.test/partial.mp4", quality: "1080p" }];
    });
    const hanging = makeScraper(
      "hang",
      ["movie"],
      () => new Promise(() => undefined),
    );

    const base = await testConfig({
      STREAM_CACHE_TTL_MS: "60000",
      STREAM_PARTIAL_CACHE_TTL_MS: "80",
    });
    const config = { ...base, globalDeadlineMs: 150, scraperTimeoutMs: 5000 };
    const { manager } = fakeSnapshots(snapshotWith([fast, hanging]));
    const { client } = fakeCinemeta(() => 603);
    const pipeline = new StreamPipeline({
      config,
      logger: silentLogger(),
      snapshots: manager,
      cinemeta: client,
    });

    const request = { type: "movie" as const, imdbId: "tt0133093" };
    const first = await pipeline.handle(request);
    expect(first).toHaveLength(1);
    await expect(pipeline.handle(request)).resolves.toEqual(first);
    expect(calls).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 120));
    await expect(pipeline.handle(request)).resolves.toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("dedupes concurrent identical requests", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scraper = makeScraper("alpha", ["movie"], async () => {
      calls += 1;
      await gate;
      return [{ url: "https://cdn.test/a.mp4", quality: "1080p" }];
    });

    const config = await testConfig();
    const { manager } = fakeSnapshots(snapshotWith([scraper]));
    const { client } = fakeCinemeta(() => 603);
    const pipeline = new StreamPipeline({
      config,
      logger: silentLogger(),
      snapshots: manager,
      cinemeta: client,
    });

    const request = { type: "movie" as const, imdbId: "tt0133093" };
    const first = pipeline.handle(request);
    const second = pipeline.handle(request);
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(b).toBe(a);
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

  it("logs one provider summary per request and records metrics", async () => {
    const good = makeScraper("good", ["movie"], async () => [
      { url: "https://cdn.test/good.mp4", quality: "1080p" },
    ]);
    const empty = makeScraper("empty", ["movie"], async () => []);
    const bad = makeScraper("bad", ["movie"], async () => {
      throw new Error("upstream exploded");
    });

    const config = await testConfig();
    const { manager } = fakeSnapshots(snapshotWith([good, empty, bad]));
    const { client } = fakeCinemeta(() => 603);
    const { logger, events } = recordingLogger();
    const pipeline = new StreamPipeline({
      config,
      logger,
      snapshots: manager,
      cinemeta: client,
    });

    await pipeline.handle({ type: "movie", imdbId: "tt0133093" });

    const summaries = events.filter(
      (entry) => entry.event === "nuvio_streams_resolved",
    );
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    expect(summary).toMatchObject({
      type: "movie",
      imdbId: "tt0133093",
      tmdbId: 603,
      outcome: "ok",
      cache: "miss",
      shared: false,
      providers: 3,
      responded: 2,
      streams: 1,
      failed: ["bad"],
      skipped: [],
    });
    expect([...(summary?.zeroHits as string[])].sort()).toEqual([
      "bad",
      "empty",
    ]);
    expect(summary?.slowest).toMatchObject({
      provider: expect.any(String),
      latencyMs: expect.any(Number),
    });
    expect(summary?.durationMs).toEqual(expect.any(Number));

    const stats = pipeline.getProviderStats();
    expect(stats.good).toMatchObject({
      calls: 1,
      ok: 1,
      responded: 1,
      empty: 0,
    });
    expect(stats.empty).toMatchObject({
      calls: 1,
      ok: 1,
      responded: 0,
      empty: 1,
    });
    expect(stats.bad).toMatchObject({
      calls: 1,
      ok: 0,
      errors: 1,
      successRate: 0,
    });
  });

  it("logs cache hits with the stored provider summary", async () => {
    let calls = 0;
    const scraper = makeScraper("alpha", ["movie"], async () => {
      calls += 1;
      return [{ url: "https://cdn.test/a.mp4", quality: "1080p" }];
    });

    const config = await testConfig({ STREAM_CACHE_TTL_MS: "60000" });
    const { manager } = fakeSnapshots(snapshotWith([scraper]));
    const { client } = fakeCinemeta(() => 603);
    const { logger, events } = recordingLogger();
    const pipeline = new StreamPipeline({
      config,
      logger,
      snapshots: manager,
      cinemeta: client,
    });

    const request = { type: "movie" as const, imdbId: "tt0133093" };
    await pipeline.handle(request);
    await pipeline.handle(request);

    expect(calls).toBe(1);
    const summaries = events.filter(
      (entry) => entry.event === "nuvio_streams_resolved",
    );
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      cache: "miss",
      shared: false,
      tmdbId: 603,
      providers: 1,
      streams: 1,
    });
    expect(summaries[1]).toMatchObject({
      cache: "hit",
      shared: false,
      tmdbId: 603,
      providers: 1,
      streams: 1,
    });
    expect(summaries[1]?.zeroHits).toEqual(summaries[0]?.zeroHits);
  });

  it("logs inflight joins as shared misses", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scraper = makeScraper("alpha", ["movie"], async () => {
      calls += 1;
      await gate;
      return [{ url: "https://cdn.test/a.mp4", quality: "1080p" }];
    });

    const config = await testConfig();
    const { manager } = fakeSnapshots(snapshotWith([scraper]));
    const { client } = fakeCinemeta(() => 603);
    const { logger, events } = recordingLogger();
    const pipeline = new StreamPipeline({
      config,
      logger,
      snapshots: manager,
      cinemeta: client,
    });

    const request = { type: "movie" as const, imdbId: "tt0133093" };
    const first = pipeline.handle(request);
    const second = pipeline.handle(request);
    release();
    await Promise.all([first, second]);

    expect(calls).toBe(1);
    const summaries = events.filter(
      (entry) => entry.event === "nuvio_streams_resolved",
    );
    expect(summaries).toHaveLength(2);
    expect(summaries.filter((entry) => entry.shared === true)).toHaveLength(1);
    expect(summaries.every((entry) => entry.cache === "miss")).toBe(true);
  });

  it("logs outcomes for unresolved ids and missing snapshots", async () => {
    const config = await testConfig();
    const request = { type: "movie" as const, imdbId: "tt0133093" };

    const missing = recordingLogger();
    const missingPipeline = new StreamPipeline({
      config,
      logger: missing.logger,
      snapshots: fakeSnapshots(snapshotWith([])).manager,
      cinemeta: fakeCinemeta(() => null).client,
    });
    await missingPipeline.handle(request);
    expect(
      missing.events.find((entry) => entry.event === "nuvio_streams_resolved"),
    ).toMatchObject({
      outcome: "tmdb_missing",
      tmdbId: null,
      providers: 0,
      cache: "miss",
    });

    const unavailable = recordingLogger();
    const unavailablePipeline = new StreamPipeline({
      config,
      logger: unavailable.logger,
      snapshots: fakeSnapshots(null).manager,
      cinemeta: fakeCinemeta(() => 603).client,
    });
    await unavailablePipeline.handle(request);
    expect(
      unavailable.events.find(
        (entry) => entry.event === "nuvio_streams_resolved",
      ),
    ).toMatchObject({
      outcome: "snapshot_unavailable",
      tmdbId: null,
      providers: 0,
      cache: "miss",
    });
  });

  it("logs pre-aborted requests as aborted misses", async () => {
    const config = await testConfig();
    const { manager } = fakeSnapshots(snapshotWith([]));
    const { client, calls } = fakeCinemeta(() => 603);
    const { logger, events } = recordingLogger();
    const pipeline = new StreamPipeline({
      config,
      logger,
      snapshots: manager,
      cinemeta: client,
    });

    const controller = new AbortController();
    controller.abort();
    await pipeline.handle(
      { type: "movie", imdbId: "tt0133093" },
      controller.signal,
    );

    expect(calls).toEqual([]);
    expect(
      events.find((entry) => entry.event === "nuvio_streams_resolved"),
    ).toMatchObject({
      outcome: "aborted",
      cache: "miss",
      tmdbId: null,
      streams: 0,
    });
  });

  it("reports providers skipped by the global deadline", async () => {
    const hung = makeScraper(
      "hung",
      ["movie"],
      () => new Promise(() => undefined),
    );
    const pending = makeScraper("pending", ["movie"], async () => [
      { url: "https://cdn.test/pending.mp4", quality: "720p" },
    ]);

    const config = await testConfig({
      GLOBAL_DEADLINE_MS: "2000",
      SCRAPER_CONCURRENCY: "1",
    });
    const { manager } = fakeSnapshots(snapshotWith([hung, pending]));
    const { client } = fakeCinemeta(() => 603);
    const { logger, events } = recordingLogger();
    const pipeline = new StreamPipeline({
      config,
      logger,
      snapshots: manager,
      cinemeta: client,
    });

    await pipeline.handle({ type: "movie", imdbId: "tt0133093" });

    const summary = events.find(
      (entry) => entry.event === "nuvio_streams_resolved",
    );
    expect(summary).toMatchObject({
      outcome: "ok",
      providers: 2,
      responded: 0,
      streams: 0,
      failed: ["hung"],
      skipped: ["pending"],
    });
    expect([...(summary?.zeroHits as string[])].sort()).toEqual([
      "hung",
      "pending",
    ]);
    expect(pipeline.getProviderStats().pending).toBeUndefined();
  });
});
