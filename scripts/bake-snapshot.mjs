import { promises as fs } from "node:fs";
import path from "node:path";

const API_BASE = "https://codeberg.org/api/v1";
const WEB_BASE = "https://codeberg.org";
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDER_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2_000;
const DOWNLOAD_CONCURRENCY = 8;

const source = process.env.NUVIO_SOURCE?.trim() || "eclipsia/nuvio-plugin";
const branch = process.env.NUVIO_BRANCH?.trim() || "main";
const pinnedSha = process.env.NUVIO_SHA?.trim() || "";
const destination = path.resolve(
  process.env.NUVIO_BUNDLED_DIR?.trim() || "snapshot",
);
const staging = `${destination}.bake-${process.pid}`;

function encodePath(value) {
  return value
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function isSafePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/")) {
    return false;
  }
  return value.split("/").every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      /^[A-Za-z0-9_.-]+$/.test(segment),
  );
}

function isRetryableError(error) {
  if (!error || typeof error !== "object") return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  if (error.name === "TypeError") return true;
  if (typeof error.status === "number") {
    return error.status === 429 || error.status >= 500;
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBufferOnce(url, maxBytes) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent": "nuvio-stremio-addon-bake",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const error = new Error(`${url} returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0 || buffer.length > maxBytes) {
    throw new Error(`${url} has invalid size (${buffer.length} bytes)`);
  }
  return buffer;
}

async function fetchBuffer(url, maxBytes) {
  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await fetchBufferOnce(url, maxBytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= REQUEST_ATTEMPTS || !isRetryableError(error)) {
        throw error;
      }
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `retrying ${url} in ${delay}ms (attempt ${attempt + 1}/${REQUEST_ATTEMPTS}): ${message}`,
      );
      await sleep(delay);
    }
  }
  throw new Error(`${url} failed after ${REQUEST_ATTEMPTS} attempts`);
}

async function resolveSha() {
  if (pinnedSha) return pinnedSha;
  const url =
    `${API_BASE}/repos/${encodePath(source)}/commits` +
    `?sha=${encodeURIComponent(branch)}&limit=1`;
  const buffer = await fetchBuffer(url, MAX_MANIFEST_BYTES);
  const parsed = JSON.parse(buffer.toString("utf8"));
  const sha = Array.isArray(parsed) ? parsed[0]?.sha : null;
  if (typeof sha !== "string" || !/^[0-9a-fA-F]{7,64}$/.test(sha)) {
    throw new Error("Codeberg API did not return a commit sha");
  }
  return sha;
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await work(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function bake() {
  const sha = await resolveSha();
  const rawBase = `${WEB_BASE}/${encodePath(source)}/raw/commit/${encodeURIComponent(sha)}`;

  const manifestBytes = await fetchBuffer(
    `${rawBase}/manifest.json`,
    MAX_MANIFEST_BYTES,
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (!Array.isArray(manifest?.scrapers)) {
    throw new Error("manifest.json has no scrapers array");
  }

  const entries = manifest.scrapers.filter(
    (entry) =>
      entry &&
      entry.enabled !== false &&
      isSafePath(entry.filename),
  );
  if (entries.length === 0) {
    throw new Error("manifest.json has no enabled scrapers");
  }

  const files = await mapLimit(
    entries,
    DOWNLOAD_CONCURRENCY,
    async (entry) => {
      const buffer = await fetchBuffer(
        `${rawBase}/${encodePath(entry.filename)}`,
        MAX_PROVIDER_BYTES,
      );
      return { filename: entry.filename, buffer };
    },
  );

  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  for (const file of files) {
    const target = path.join(staging, file.filename);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.buffer);
  }
  await fs.writeFile(path.join(staging, "manifest.json"), manifestBytes);
  await fs.writeFile(
    path.join(staging, "state.json"),
    JSON.stringify({ sha, fetchedAt: Date.now() }),
  );

  await fs.rm(destination, { recursive: true, force: true });
  await fs.rename(staging, destination);

  const bytes = files.reduce((total, file) => total + file.buffer.length, 0);
  console.log(
    `baked ${files.length} providers (${bytes} bytes) from ${source}@${sha} into ${destination}`,
  );
}

bake().catch(async (error) => {
  await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  console.error(
    `snapshot bake failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
