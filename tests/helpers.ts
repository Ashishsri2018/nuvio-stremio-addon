import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import type { AppConfig, LogLevel, NuvioScraperEntry } from "../src/types.js";

export interface FixtureServer {
  url: string;
  port: number;
  requests: string[];
  close(): Promise<void>;
}

export async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<FixtureServer> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function text(
  res: http.ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.end(body);
}

export async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function silentLogger(): Logger {
  return new Logger({ level: "error", write: () => undefined });
}

export interface RecordedLog {
  ts: string;
  level: LogLevel;
  event: string;
  [field: string]: unknown;
}

export function recordingLogger(): { logger: Logger; events: RecordedLog[] } {
  const events: RecordedLog[] = [];
  const logger = new Logger({
    level: "debug",
    write: (line) => {
      events.push(JSON.parse(line) as RecordedLog);
    },
  });
  return { logger, events };
}

export async function testConfig(
  overrides: Record<string, string | undefined> = {},
): Promise<AppConfig> {
  const cacheDir = await tempDir("nuvio-test-");
  return loadConfig({
    NUVIO_CACHE_DIR: cacheDir,
    LOG_LEVEL: "error",
    ...overrides,
  });
}

export function makeEntry(
  overrides: Partial<NuvioScraperEntry> = {},
): NuvioScraperEntry {
  return {
    id: "demo",
    name: "Demo",
    description: null,
    version: "1.0.0",
    author: null,
    supportedTypes: ["movie", "tv"],
    filename: "providers/demo.js",
    enabled: true,
    formats: ["mp4"],
    contentLanguage: ["en"],
    hasSettings: false,
    disabledPlatforms: [],
    ...overrides,
  };
}
