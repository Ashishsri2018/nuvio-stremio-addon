import { afterEach, describe, expect, it } from "vitest";
import { SnapshotManager } from "../src/nuvio/snapshot.js";
import { CodebergClient } from "../src/source/codeberg.js";
import {
  json,
  silentLogger,
  startServer,
  testConfig,
  text,
  type FixtureServer,
} from "./helpers.js";

const SHA = "abcdef1234567890";

const MANIFEST = {
  name: "Nuvio Test",
  version: "1.0.0",
  scrapers: [
    {
      id: "alpha",
      name: "Alpha",
      filename: "providers/alpha.js",
      supportedTypes: ["movie", "tv"],
      enabled: true,
    },
    {
      id: "beta",
      name: "Beta",
      filename: "providers/beta.js",
      supportedTypes: ["tv"],
      enabled: true,
    },
    {
      id: "gamma",
      name: "Gamma",
      filename: "providers/gamma.js",
      supportedTypes: ["movie"],
      enabled: false,
    },
  ],
};

function providerCode(id: string): string {
  return `
    module.exports.getStreams = async function (tmdbId, mediaType, season, episode) {
      return [{
        name: "${id}",
        title: "${id} stream",
        url: "https://cdn.test/${id}-" + tmdbId + ".mp4",
        quality: "1080p"
      }];
    };
  `;
}

let server: FixtureServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function createClient(url: string): CodebergClient {
  return new CodebergClient({
    source: "acme/plugin",
    branch: "main",
    logger: silentLogger(),
    apiBaseUrl: `${url}/api/v1`,
    webBaseUrl: url,
    timeoutMs: 2000,
  });
}

describe("SnapshotManager", () => {
  it("downloads, evaluates, persists, and reloads a snapshot from disk", async () => {
    server = await startServer((req, res) => {
      if (req.url?.startsWith("/api/v1/repos/acme/plugin/commits")) {
        json(res, 200, [{ sha: SHA }]);
        return;
      }
      if (req.url === `/acme/plugin/raw/commit/${SHA}/manifest.json`) {
        json(res, 200, MANIFEST);
        return;
      }
      const match = /^\/acme\/plugin\/raw\/commit\/[^/]+\/(providers\/[a-z]+\.js)$/.exec(
        req.url ?? "",
      );
      if (match?.[1]) {
        text(res, 200, providerCode(match[1]), "application/javascript");
        return;
      }
      text(res, 404, "missing");
    });

    const config = await testConfig();
    const manager = new SnapshotManager(
      config,
      silentLogger(),
      createClient(server.url),
    );

    const snapshot = await manager.ensure();
    expect(snapshot?.sha).toBe(SHA);
    expect(snapshot?.scrapers.map((scraper) => scraper.entry.id).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    expect(snapshot?.scrapers[0]?.entry.name).toBe("Alpha");
    expect(server.requests.some((url) => url.endsWith("/providers/alpha.js"))).toBe(
      true,
    );
    expect(server.requests.some((url) => url.endsWith("/providers/beta.js"))).toBe(
      true,
    );
    expect(server.requests.some((url) => url.endsWith("/providers/gamma.js"))).toBe(
      false,
    );

    const health = manager.getHealth();
    expect(health).toMatchObject({
      status: "ok",
      sha: SHA,
      scraperCount: 2,
      lastError: null,
      refreshing: false,
    });

    const beforeReload = server.requests.length;
    const warmManager = new SnapshotManager(
      config,
      silentLogger(),
      createClient(server.url),
    );
    const warm = await warmManager.ensure();
    expect(warm?.sha).toBe(SHA);
    expect(warm?.scrapers).toHaveLength(2);
    expect(server.requests.length).toBe(beforeReload);

    const beforeForce = server.requests.length;
    const refreshed = await manager.refresh(true);
    expect(refreshed?.sha).toBe(SHA);
    expect(refreshed?.fetchedAt ?? 0).toBeGreaterThanOrEqual(
      snapshot?.fetchedAt ?? 0,
    );
    expect(server.requests.length).toBeGreaterThan(beforeForce);
  });

  it("keeps the active snapshot when a forced refresh fails", async () => {
    let fail = false;
    server = await startServer((req, res) => {
      if (fail) {
        text(res, 500, "down");
        return;
      }
      if (req.url?.startsWith("/api/v1/repos/acme/plugin/commits")) {
        json(res, 200, [{ sha: SHA }]);
        return;
      }
      if (req.url === `/acme/plugin/raw/commit/${SHA}/manifest.json`) {
        json(res, 200, MANIFEST);
        return;
      }
      const match = /^\/acme\/plugin\/raw\/commit\/[^/]+\/(providers\/[a-z]+\.js)$/.exec(
        req.url ?? "",
      );
      if (match?.[1]) {
        text(res, 200, providerCode(match[1]), "application/javascript");
        return;
      }
      text(res, 404, "missing");
    });

    const config = await testConfig();
    const manager = new SnapshotManager(
      config,
      silentLogger(),
      createClient(server.url),
    );
    const snapshot = await manager.ensure();
    expect(snapshot).not.toBeNull();

    fail = true;
    const result = await manager.refresh(true);
    expect(result).toBe(snapshot);
    expect(manager.getSnapshot()).toBe(snapshot);
    const health = manager.getHealth();
    expect(health.status).toBe("degraded");
    expect(health.sha).toBe(SHA);
    expect(health.lastError).toBeTruthy();
  });

  it("falls back to the branch endpoint when the head lookup fails", async () => {
    server = await startServer((req, res) => {
      if (req.url?.startsWith("/api/v1/repos/acme/plugin/commits")) {
        text(res, 500, "api down");
        return;
      }
      if (req.url === "/acme/plugin/raw/branch/main/manifest.json") {
        json(res, 200, MANIFEST);
        return;
      }
      const match = /^\/acme\/plugin\/raw\/branch\/main\/(providers\/[a-z]+\.js)$/.exec(
        req.url ?? "",
      );
      if (match?.[1]) {
        text(res, 200, providerCode(match[1]), "application/javascript");
        return;
      }
      text(res, 404, "missing");
    });

    const config = await testConfig();
    const manager = new SnapshotManager(
      config,
      silentLogger(),
      createClient(server.url),
    );
    const snapshot = await manager.ensure();
    expect(snapshot?.sha).toMatch(/^branch-[0-9a-f]{16}$/);
    expect(snapshot?.scrapers).toHaveLength(2);
    expect(
      server.requests.some((url) => url.includes("/raw/branch/main/")),
    ).toBe(true);
  });

  it("honours the disabled scraper list", async () => {
    server = await startServer((req, res) => {
      if (req.url?.startsWith("/api/v1/repos/acme/plugin/commits")) {
        json(res, 200, [{ sha: SHA }]);
        return;
      }
      if (req.url === `/acme/plugin/raw/commit/${SHA}/manifest.json`) {
        json(res, 200, MANIFEST);
        return;
      }
      const match = /^\/acme\/plugin\/raw\/commit\/[^/]+\/(providers\/[a-z]+\.js)$/.exec(
        req.url ?? "",
      );
      if (match?.[1]) {
        text(res, 200, providerCode(match[1]), "application/javascript");
        return;
      }
      text(res, 404, "missing");
    });

    const config = await testConfig({ DISABLED_SCRAPERS: "beta" });
    const manager = new SnapshotManager(
      config,
      silentLogger(),
      createClient(server.url),
    );
    const snapshot = await manager.ensure();
    expect(snapshot?.scrapers.map((scraper) => scraper.entry.id)).toEqual([
      "alpha",
    ]);
    expect(server.requests.some((url) => url.endsWith("/providers/beta.js"))).toBe(
      false,
    );
  });
});
