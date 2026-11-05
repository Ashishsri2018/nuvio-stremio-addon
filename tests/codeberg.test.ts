import { afterEach, describe, expect, it } from "vitest";
import { CodebergClient } from "../src/source/codeberg.js";
import { json, silentLogger, startServer, text, type FixtureServer } from "./helpers.js";

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

describe("CodebergClient", () => {
  it("resolves the branch head and downloads raw files", async () => {
    server = await startServer((req, res) => {
      if (req.url?.startsWith("/api/v1/repos/acme/plugin/commits")) {
        json(res, 200, [{ sha: "abcdef1234567890" }]);
        return;
      }
      if (req.url === "/acme/plugin/raw/commit/abcdef1234567890/manifest.json") {
        json(res, 200, { name: "Nuvio", scrapers: [] });
        return;
      }
      if (req.url === "/acme/plugin/raw/commit/abcdef1234567890/providers/demo.js") {
        text(res, 200, "module.exports = {};", "application/javascript");
        return;
      }
      text(res, 404, "missing");
    });

    const client = createClient(server.url);
    await expect(client.resolveHead()).resolves.toBe("abcdef1234567890");
    const manifest = await client.fetchJson<{ name: string }>(
      "abcdef1234567890",
      "manifest.json",
    );
    expect(manifest.name).toBe("Nuvio");
    const code = await client.fetchFile(
      "abcdef1234567890",
      "providers/demo.js",
    );
    expect(code.toString("utf8")).toContain("module.exports");
  });

  it("retries server errors and does not retry 404s", async () => {
    let headAttempts = 0;
    server = await startServer((req, res) => {
      if (req.url?.startsWith("/api/v1/repos/acme/plugin/commits")) {
        headAttempts += 1;
        if (headAttempts === 1) {
          text(res, 500, "boom");
          return;
        }
        json(res, 200, [{ sha: "abcdef1234567890" }]);
        return;
      }
      text(res, 404, "missing");
    });

    const client = createClient(server.url);
    await expect(client.resolveHead()).resolves.toBe("abcdef1234567890");
    expect(headAttempts).toBe(2);

    const before = server.requests.length;
    await expect(client.fetchFile("abcdef1234567890", "providers/none.js")).rejects.toThrow(
      /404/,
    );
    expect(server.requests.length - before).toBe(1);
  });

  it("rejects unsafe paths", async () => {
    const client = createClient("http://127.0.0.1:1");
    await expect(client.fetchFile("abcdef1234567890", "../secret.js")).rejects.toThrow(
      /Unsafe/,
    );
  });
});
