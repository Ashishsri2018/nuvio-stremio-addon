import { createHash } from "node:crypto";
import type { LoggerLike } from "../types.js";
import { nativeFetch } from "../util/nativeFetch.js";

const DEFAULT_API_BASE = "https://codeberg.org/api/v1";
const DEFAULT_WEB_BASE = "https://codeberg.org";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface CodebergClientOptions {
  source: string;
  branch: string;
  logger: LoggerLike;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  apiBaseUrl?: string;
  webBaseUrl?: string;
}

export class CodebergHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "CodebergHttpError";
    this.status = status;
  }
}

function encodePath(value: string): string {
  return value
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function isSafePath(value: string): boolean {
  if (value.length === 0 || value.startsWith("/")) return false;
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      /^[A-Za-z0-9_.-]+$/.test(segment),
  );
}

function joinBase(base: string, ...suffixes: string[]): string {
  return `${base.replace(/\/+$/, "")}/${suffixes.join("/")}`;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RawResponse {
  status: number;
  ok: boolean;
  body: Buffer;
}

export class CodebergClient {
  private readonly source: string;
  private readonly branch: string;
  private readonly logger: LoggerLike;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly apiBase: string;
  private readonly webBase: string;

  constructor(options: CodebergClientOptions) {
    this.source = options.source;
    this.branch = options.branch;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? nativeFetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.apiBase = options.apiBaseUrl ?? DEFAULT_API_BASE;
    this.webBase = options.webBaseUrl ?? DEFAULT_WEB_BASE;
  }

  async resolveHead(): Promise<string> {
    const url = `${joinBase(
      this.apiBase,
      "repos",
      encodePath(this.source),
      "commits",
    )}?sha=${encodeURIComponent(this.branch)}&limit=1`;
    const { response, body } = await this.requestWithRetry(url, "head");
    if (!response.ok) {
      throw new CodebergHttpError(
        `Codeberg API request failed with status ${response.status}`,
        response.status,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripBom(body.toString("utf8")));
    } catch {
      throw new Error("Codeberg API returned invalid JSON");
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("Codeberg API returned an empty commit list");
    }
    const first = parsed[0];
    if (!isRecord(first) || typeof first.sha !== "string" || first.sha.length === 0) {
      throw new Error("Codeberg API response is missing a commit sha");
    }
    return first.sha;
  }

  async fetchFile(sha: string | null, filePath: string): Promise<Buffer> {
    if (!isSafePath(filePath)) {
      throw new Error(`Unsafe Codeberg path: ${filePath}`);
    }
    const encodedPath = encodePath(filePath);
    let url: string;
    if (sha) {
      url = joinBase(
        this.webBase,
        encodePath(this.source),
        "raw",
        "commit",
        encodeURIComponent(sha),
        encodedPath,
      );
    } else {
      const branchPath = this.branch
        .split("/")
        .filter((segment) => segment.length > 0)
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      url = joinBase(
        this.webBase,
        encodePath(this.source),
        "raw",
        "branch",
        branchPath,
        encodedPath,
      );
    }

    const { response, body } = await this.requestWithRetry(url, "raw");
    if (!response.ok) {
      throw new CodebergHttpError(
        `Raw download failed with status ${response.status} for ${filePath}`,
        response.status,
      );
    }
    return body;
  }

  async fetchJson<T>(sha: string | null, filePath: string): Promise<T> {
    const body = await this.fetchFile(sha, filePath);
    try {
      return JSON.parse(stripBom(body.toString("utf8"))) as T;
    } catch {
      throw new Error(`Invalid JSON in ${filePath}`);
    }
  }

  private async requestWithRetry(
    url: string,
    label: string,
  ): Promise<{ response: { ok: boolean; status: number }; body: Buffer }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await this.requestOnce(url, label);
        if (result.status >= 500) {
          throw new CodebergHttpError(
            `Codeberg ${label} request failed with status ${result.status}`,
            result.status,
          );
        }
        return {
          response: { ok: result.ok, status: result.status },
          body: result.body,
        };
      } catch (error) {
        lastError = error;
        if (error instanceof CodebergHttpError && error.status < 500) {
          throw error;
        }
        if (attempt === 1) {
          this.logger.warn("codeberg_request_retry", {
            label,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Codeberg ${label} request failed`);
  }

  private async requestOnce(url: string, label: string): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`${label} request timed out`));
    }, this.timeoutMs);
    timer.unref?.();

    try {
      const response = await this.fetchImpl(url, {
        headers: {
          Accept: "application/json, text/plain, */*",
          "User-Agent": "nuvio-stremio-addon",
        },
        redirect: "follow",
        signal: controller.signal,
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { status: response.status, ok: false, body: Buffer.alloc(0) };
      }

      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Response exceeds the ${MAX_FILE_BYTES} byte limit`);
      }

      if (!response.body) {
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > MAX_FILE_BYTES) {
          throw new Error(`Response exceeds the ${MAX_FILE_BYTES} byte limit`);
        }
        return { status: response.status, ok: true, body };
      }

      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > MAX_FILE_BYTES) {
            controller.abort(new Error("Response size limit exceeded"));
            await reader.cancel().catch(() => undefined);
            throw new Error(`Response exceeds the ${MAX_FILE_BYTES} byte limit`);
          }
          chunks.push(Buffer.from(value));
        }
      }
      return {
        status: response.status,
        ok: true,
        body: Buffer.concat(chunks, total),
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`${label} request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function computeSnapshotSha(parts: Buffer[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update(Buffer.from([0]));
  }
  return `branch-${hash.digest("hex").slice(0, 16)}`;
}
