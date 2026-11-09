import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/addon/app.js";
import type { StreamPipeline } from "../src/nuvio/pipeline.js";
import type { SnapshotManager } from "../src/nuvio/snapshot.js";
import type { HealthReport, StreamRequest } from "../src/types.js";
import { silentLogger, testConfig } from "./helpers.js";

interface RunningApp {
  url: string;
  close(): Promise<void>;
}

const servers: RunningApp[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function listen(app: Express): Promise<RunningApp> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const running: RunningApp = {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  servers.push(running);
  return running;
}

const HEALTH: HealthReport = {
  status: "ok",
  sha: "abcdef1234567890",
  fetchedAt: "2026-11-05T00:00:00.000Z",
  scraperCount: 51,
  lastError: null,
  refreshing: false,
};

async function createServer(
  pipelineHandle?: StreamPipeline["handle"],
  providerStats: StreamPipeline["getProviderStats"] = () => ({}),
) {
  const calls: StreamRequest[] = [];
  const handle =
    pipelineHandle ??
    (async (request: StreamRequest) => {
      calls.push(request);
      return [
        {
          name: "Alpha",
          url: "https://cdn.test/movie.mp4",
          behaviorHints: { bingeGroup: "alpha-1080p" },
          subtitles: [
            { id: "alpha-0", url: "https://cdn.test/en.vtt", lang: "English" },
            { id: "alpha-0-1", url: "https://cdn.test/hi.vtt", lang: "Hindi" },
          ],
        },
      ];
    });

  const pipeline = {
    handle,
    collectSubtitles: async (request: StreamRequest, signal?: AbortSignal) => {
      const streams = await handle(request, signal);
      const seen = new Set<string>();
      const subtitles = [];
      for (const stream of streams) {
        for (const track of stream.subtitles ?? []) {
          if (seen.has(track.url)) continue;
          seen.add(track.url);
          subtitles.push(track);
        }
      }
      return subtitles;
    },
    getProviderStats: providerStats,
  } as unknown as StreamPipeline;
  const snapshots = { getHealth: () => HEALTH } as unknown as SnapshotManager;
  const config = await testConfig();
  const app = createApp({ config, logger: silentLogger(), pipeline, snapshots });
  const running = await listen(app);
  return { running, calls };
}

describe("addon routes", () => {
  it("serves the Stremio manifest with CORS", async () => {
    const { running } = await createServer();
    const response = await fetch(`${running.url}/manifest.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const manifest = (await response.json()) as {
      id: string;
      types: string[];
      resources: string[];
      idPrefixes: string[];
      behaviorHints: { configurable?: boolean };
    };
    expect(manifest.id).toBe("community.nuvio.stremio");
    expect(manifest.types).toEqual(["movie", "series"]);
    expect(manifest.resources).toEqual(["stream", "subtitles"]);
    expect(manifest.idPrefixes).toEqual(["tt"]);
    expect(manifest.behaviorHints).toEqual({ configurable: true });
  });

  it("serves the configure page with and without a config prefix", async () => {
    const { running } = await createServer();
    for (const path of ["/configure", "/max/configure"]) {
      const response = await fetch(`${running.url}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("cache-control")).toBe("public, max-age=300");
      expect(await response.text()).toContain("Nuvio Streams");
    }
  });

  it("serves the manifest under a config prefix", async () => {
    const { running } = await createServer();
    const base = await fetch(`${running.url}/manifest.json`);
    const prefixed = await fetch(`${running.url}/max/manifest.json`);
    expect(prefixed.status).toBe(200);
    expect(await prefixed.json()).toEqual(await base.json());
  });

  it("applies URL-embedded stream filters", async () => {
    const { running } = await createServer();
    const segment = Buffer.from(
      JSON.stringify({ v: 1, maxRes: 720 }),
      "utf8",
    ).toString("base64url");

    const filtered = await fetch(
      `${running.url}/${segment}/stream/movie/tt0133093.json`,
    );
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toEqual({ streams: [] });

    const unfiltered = await fetch(`${running.url}/stream/movie/tt0133093.json`);
    const body = (await unfiltered.json()) as { streams: unknown[] };
    expect(body.streams).toHaveLength(1);

    const invalid = await fetch(
      `${running.url}/bm90LWpzb24/stream/movie/tt0133093.json`,
    );
    expect(invalid.status).toBe(200);
    expect(((await invalid.json()) as { streams: unknown[] }).streams).toHaveLength(1);
  });

  it("maps movie stream requests", async () => {
    const { running, calls } = await createServer();
    const response = await fetch(`${running.url}/stream/movie/tt0133093.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(calls).toEqual([{ type: "movie", imdbId: "tt0133093" }]);
    const body = (await response.json()) as { streams: unknown[] };
    expect(body.streams).toHaveLength(1);
    expect(body.streams[0]).toMatchObject({
      url: "https://cdn.test/movie.mp4",
    });
  });

  it("maps series stream requests and accepts ids without .json", async () => {
    const { running, calls } = await createServer();
    const response = await fetch(
      `${running.url}/stream/series/tt0944947:1:2.json`,
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { type: "series", imdbId: "tt0944947", season: 1, episode: 2 },
    ]);

    const bare = await fetch(`${running.url}/stream/movie/tt0133093`);
    expect(bare.status).toBe(200);
  });

  it("returns 200 with empty streams for invalid ids", async () => {
    const { running, calls } = await createServer();
    const paths = [
      "/stream/movie/not-an-imdb.json",
      "/stream/movie/tt0133093:1:1.json",
      "/stream/series/tt0944947.json",
      "/stream/foo/tt0944947.json",
      "/stream/movie/tt.json",
    ];
    for (const path of paths) {
      const response = await fetch(`${running.url}${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ streams: [] });
    }
    expect(calls).toEqual([]);
  });

  it("still returns 200 with empty streams when the pipeline throws", async () => {
    const { running } = await createServer(async () => {
      throw new Error("failure");
    });
    const response = await fetch(`${running.url}/stream/movie/tt0133093.json`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ streams: [] });
  });

  it("answers HEAD requests without running the pipeline", async () => {
    const { running, calls } = await createServer();
    const response = await fetch(`${running.url}/stream/movie/tt0133093.json`, {
      method: "HEAD",
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("aggregates provider subtitles for movie and series requests", async () => {
    const { running, calls } = await createServer();
    const movie = await fetch(`${running.url}/subtitles/movie/tt0133093.json`);
    expect(movie.status).toBe(200);
    expect(movie.headers.get("cache-control")).toBe("no-store");
    expect(await movie.json()).toEqual({
      subtitles: [
        { id: "alpha-0", url: "https://cdn.test/en.vtt", lang: "English" },
        { id: "alpha-0-1", url: "https://cdn.test/hi.vtt", lang: "Hindi" },
      ],
    });

    const series = await fetch(
      `${running.url}/subtitles/series/tt0944947:1:2.json`,
    );
    expect(series.status).toBe(200);
    expect(calls).toEqual([
      { type: "movie", imdbId: "tt0133093" },
      { type: "series", imdbId: "tt0944947", season: 1, episode: 2 },
    ]);
  });

  it("accepts the Stremio extras segment and config prefix on subtitle routes", async () => {
    const { running, calls } = await createServer();
    const segment = Buffer.from(
      JSON.stringify({ v: 1, maxRes: 720 }),
      "utf8",
    ).toString("base64url");

    for (const path of [
      "/subtitles/movie/tt0133093/videoHash=abc&filename=movie.mkv.json",
      `/${segment}/subtitles/movie/tt0133093.json`,
    ]) {
      const response = await fetch(`${running.url}${path}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { subtitles: unknown[] };
      expect(body.subtitles).toHaveLength(2);
    }
    expect(calls).toHaveLength(2);
  });

  it("returns 200 with empty subtitles for invalid ids and failures", async () => {
    const ok = await createServer();
    for (const path of [
      "/subtitles/movie/not-an-imdb.json",
      "/subtitles/series/tt0944947.json",
      "/subtitles/foo/tt0944947.json",
    ]) {
      const response = await fetch(`${ok.running.url}${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ subtitles: [] });
    }
    expect(ok.calls).toEqual([]);

    const failing = await createServer(async () => {
      throw new Error("failure");
    });
    const broken = await fetch(
      `${failing.running.url}/subtitles/movie/tt0133093.json`,
    );
    expect(broken.status).toBe(200);
    expect(await broken.json()).toEqual({ subtitles: [] });
  });

  it("answers HEAD subtitle requests without running the pipeline", async () => {
    const { running, calls } = await createServer();
    const response = await fetch(`${running.url}/subtitles/movie/tt0133093.json`, {
      method: "HEAD",
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("reports health", async () => {
    const { running } = await createServer();
    const response = await fetch(`${running.url}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ...HEALTH, providers: {} });
  });

  it("includes provider stats in health", async () => {
    const stats = {
      alpha: {
        calls: 2,
        ok: 2,
        responded: 1,
        empty: 1,
        errors: 0,
        timeouts: 0,
        skipped: 0,
        successRate: 1,
        p50Ms: 10,
        p95Ms: 20,
      },
    };
    const { running } = await createServer(undefined, () => stats);
    const response = await fetch(`${running.url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...HEALTH, providers: stats });
  });

  it("falls back when provider stats fail", async () => {
    const { running } = await createServer(undefined, () => {
      throw new Error("stats down");
    });
    const response = await fetch(`${running.url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "error",
      sha: null,
      fetchedAt: null,
      scraperCount: 0,
      lastError: "health check failed",
      refreshing: false,
      providers: {},
    });
  });

  it("handles CORS preflight and unknown routes", async () => {
    const { running } = await createServer();
    const options = await fetch(`${running.url}/manifest.json`, { method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-methods")).toBe(
      "GET, HEAD, OPTIONS",
    );

    const missing = await fetch(`${running.url}/nope`);
    expect(missing.status).toBe(404);
  });
});
