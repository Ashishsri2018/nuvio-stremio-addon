# Architecture

## Purpose

This addon exposes the `eclipsia/nuvio-plugin` provider bundle as a standard Stremio stream addon. Nuvio providers are CommonJS modules that export `getStreams(tmdbId, mediaType, season, episode)` and normally run on-device inside the Nuvio app. This service downloads them from Codeberg, evaluates them in-process, and serves Stremio's `/stream` protocol keyed by IMDb ids.

Two policies shape the design:

1. **Direct URLs.** Provider media URLs are returned untouched. When `PROXY_ENABLED=true`, provider request headers are attached as `behaviorHints.proxyHeaders.request`; the addon has no `/proxy` route and never rewrites URLs.
2. **Env-only server configuration, URL-embedded user filters.** Server settings come from env vars validated by zod at startup; there is no database. Per-install stream filters live in a base64url path segment (`/<config>/manifest.json`), are parsed per request, and are never stored.

## Component map

```
src/
  config.ts              zod env schema -> AppConfig
  runtime.ts             createRuntime()/getRuntime() wiring (cached per process)
  local.ts               local Express listener (dev/self-host, not Vercel)
  logger.ts              structured JSON logger with key/URL redaction
  types.ts               Stremio, Nuvio, config, health types
  addon/
    app.ts               Express routes, CORS, always-200 semantics, per-request filtering
    manifest.ts          static Stremio manifest
    configure.ts         static /configure HTML page
    userConfig.ts        base64url filter segment: schema, encode/parse, filterStreams
    parseId.ts           tt... / tt...:S:E parser
    mapStreams.ts        Nuvio -> Stremio mapping, quality/size inference, sort, dedupe
  cinemeta/client.ts     IMDb -> TMDB via Cinemeta, TMDB /find fallback
  source/codeberg.ts     head resolution, raw downloads, retries, size/path limits
  nuvio/
    manifest.ts          upstream manifest.json validation + scraper selection
    loader.ts            provider module evaluation, shims, two-pass settings
    snapshot.ts          SnapshotManager: TTL, disk cache, atomic swap
    pipeline.ts          TMDB resolution, fan-out, deadlines, stream cache
  util/
    nativeFetch.ts       bound original global fetch
    concurrency.ts       Semaphore, mapLimit, mapLimitSettled, withTimeout, sleep
    fs.ts                atomic writes, directory helpers
api/
  index.ts               Vercel function; default-exports the Express app
  cron/refresh.ts        Vercel cron function; Bearer CRON_SECRET + force refresh
```

## Request lifecycle

```
GET /stream/movie/tt0133093.json          (or /<config>/stream/...)
        |
        v
parseStreamId(type, id) -- invalid --> 200 {"streams":[]}
        |
        v
StreamPipeline.handle(request, signal)
        |
        +--> in-memory cache hit (key type:imdbId:season:episode) --> return
        +--> identical in-flight request --> join its promise
        |
        +--> CinemetaClient.resolveTmdbId(type, imdbId)
        |      Cinemeta /meta/{movie|series}/{imdbId}.json -> meta.moviedb_id
        |      fallback: TMDB /find/{imdbId}?external_source=imdb_id (if TMDB_API_KEY)
        |
        +--> SnapshotManager.ensure()
        |      fresh in memory -> use; fresh on disk -> load;
        |      fresh bundled -> load; else refresh
        |
        +--> filter scanners by supportedTypes
        |      movie  -> includes "movie"
        |      series -> includes "tv" or "series"
        |
        +--> collectStreams(concurrency, global deadline, provider timeout)
        |      workers call scraper.getStreams(tmdbId, "movie"|"tv", season, episode)
        |      per-call timeout = min(SCRAPER_TIMEOUT_MS, remaining deadline);
        |      failures logged and skipped
        |
        +--> mapScraperStreams per provider -> sortStreams -> cap 300
        |
        +--> store in stream cache (STREAM_CACHE_TTL_MS, max 500 entries)
        |
        v
filterStreams(streams, parseUserConfig(req.params.config))
        |      resolution bounds, unknown-quality toggle, size cap,
        |      subtitle language trimming (codes or provider names);
        |      invalid segment -> defaults
        v
200 {"streams":[...]} (always)
```

The pipeline cache stores unfiltered streams keyed by `type:imdbId:season:episode`, so every config segment shares the same upstream work; filtering is applied per request. Identical requests that arrive while one is still running join that promise instead of starting a second fan-out. Production uses a 5-minute cache TTL; aborted requests bypass the cache.

`StreamRequest.type` is Stremio's `"movie"`/`"series"`; the provider-facing media type is `"movie"`/`"tv"`. Series-only ids without a season (`tt...:S`) are accepted and forward `episode === undefined`.

If the request socket closes, `app.ts` aborts the `AbortController` and the pipeline stops early. Aborted requests are not cached.

## Snapshot lifecycle

A snapshot is the upstream `manifest.json` plus enabled provider files, evaluated once into `LoadedScraper[]`.

1. **Head resolution.** Without `NUVIO_SHA`, `CodebergClient.resolveHead()` calls
   `GET {api}/repos/{source}/commits?sha={branch}&limit=1` and uses the first `sha`.
2. **Download.** `manifest.json` and each selected `providers/<name>.js` are fetched from
   `{web}/{source}/raw/commit/{sha}/{path}`. If head resolution fails, files come from
   `{web}/{source}/raw/branch/{branch}/{path}` and the snapshot id becomes
   `branch-<first 16 hex of sha256(contents)>`.
3. **Validation.** Manifest must be an object with a `scrapers` array (max 200); scraper ids match `[A-Za-z0-9_.-]+`, filenames match `providers/<safe>.js`, duplicates are rejected, and `enabled: false` or `DISABLED_SCRAPERS` entries are skipped. Provider files must be 1 byte to 2 MB; the manifest is capped at 8 MB. Paths are rejected if any segment is `.`/`..` or contains unsafe characters.
4. **Evaluation.** Providers are loaded with concurrency 8. A snapshot activates only if at least one scraper loads.
5. **Persistence.** Files are written into a staging directory, then atomically renamed to `{NUVIO_CACHE_DIR}/{sha}/`. `state.json` is written atomically with `{sha, fetchedAt}`. Older snapshot dirs and stale temp dirs are removed.
6. **Activation.** The in-memory snapshot reference is swapped only after a complete successful build. The old snapshot stays active on any failure and `lastError` is recorded.
7. **Freshness.** `ensure()` treats a snapshot as fresh for `NUVIO_UPDATE_INTERVAL_HOURS` (default 24). `refresh(force)` bypasses freshness; the cron handler uses it. Concurrent callers share a single in-flight refresh promise.
8. **Warm starts.** A fresh `state.json` lets a new function instance load the snapshot from disk without contacting Codeberg. On Vercel this only helps within the same instance's `/tmp`.
9. **Bundled snapshot.** When `NUVIO_BUNDLED_DIR` is set, a fresh bundled snapshot is loaded before any network call, and a bundled snapshot is used as a last resort if a refresh fails. `npm run bake` writes it; `snapshot/` is gitignored and shipped to Vercel via `includeFiles`.

`GET /health` exposes the active `sha`, `fetchedAt`, `scraperCount`, `lastError`, `refreshing`, and the per-provider `providers` block (see Observability).

## Provider runtime

`src/nuvio/loader.ts` evaluates provider source with:

```ts
new Function("module", "exports", "require", "fetch", "TMDB_API_KEY",
             "SCRAPER_SETTINGS", "__filename", "__dirname", code)
```

- `require` is whitelisted: `cheerio`, `cheerio-without-node-native` (aliased to cheerio), and `crypto-js`. Unknown modules throw at load time.
- `fetch` is a wrapper over the original global fetch that adds `AbortSignal.timeout(HTTP_TIMEOUT_MS)` and combines it with any caller signal. `globalThis.fetch` is never replaced.
- Node >= 22 provides `atob`, `btoa`, `crypto.getRandomValues`, `Buffer`, and `URL` used by some providers.
- Settings are baked in at load time because providers read `TMDB_API_KEY` / `SCRAPER_SETTINGS` in top-level code. Loading is two-pass:
  1. evaluate with env overrides only and call optional `onSettings()` (3 s timeout) to collect `defaultValue`s;
  2. merge `defaults <- env overrides` (env wins) and re-evaluate only if the effective settings changed.
- `onSettings` errors are ignored. A module must export a `getStreams` function or it is rejected.

Provider execution is in-process and unsandboxed. The trust boundary is the pinned upstream commit plus path/size validation.

## Stream mapping

`mapScraperStreams(rawStreams, { scraperId, scraperName, proxyEnabled })`:

- Accepts only objects with a non-empty `http:`/`https:` `url`. Magnets, other schemes, malformed URLs, and placeholder hosts (`example.com`, `localhost`, `127.0.0.1`, etc.) are dropped.
- `name` is the upstream manifest display name.
- `title` is `stream.title || stream.name || quality`; if the quality token is not already present, it appends ` • <quality>`.
- `headers` are trimmed, validated (RFC 7230 token names, no CRLF), and filtered for hop-by-hop and `proxy-*` headers. They are attached only when `PROXY_ENABLED=true` and at least one survives, as `behaviorHints.proxyHeaders.request`.
- `bingeGroup` is `<scraperId>-<quality|auto>`.
- `subtitles` accept `{url, language?, name?}` with http(s) URLs and become Stremio `{id, url, lang}` (language defaults to `en`). Providers usually emit full names (`English`, `Brazilian`); `userConfig` normalizes both those and configured ISO codes before matching (`LANGUAGE_ALIASES`).
- At most 20 streams per provider; URLs are deduped.
- `sortStreams` dedupes globally by URL, sorts by inferred quality (`8k`, `4k`, `uhd`, `qhd`, `fhd`, `###p`, bare resolutions), then prefers direct files (`.mp4`, `.mkv`, etc.) over unknown formats over HLS/DASH. Otherwise input order is preserved.
- The pipeline caps the combined result at 300 streams.

## Observability

- `nuvio_snapshot_activated` records `source` as `disk`, `bundled`, or `network`, plus `sha`, scraper count, and `fetchedAt`.
- Every stream request emits exactly one `nuvio_streams_resolved` summary from `StreamPipeline.handle()` (miss, cache hit, and inflight join alike): `type`, `imdbId`, `season`/`episode`, `tmdbId`, `outcome` (`ok`, `tmdb_missing`, `snapshot_unavailable`, `aborted`, `error`), `cache` (`hit`/`miss`), `shared`, `providers`, `responded`, `streams`, `zeroHits`, `failed`, `skipped`, `slowest` (`{provider, latencyMs}`), and `durationMs`. Only ids, counts, and latencies are logged; stream URLs, headers, settings, and error messages are not added.
- `zeroHits` lists every eligible provider that produced no raw streams, including empty responses, failures, timeouts, and deadline skips; `failed` and `skipped` identify the reason. `slowest` includes timeout attempts.
- `src/nuvio/metrics.ts` keeps in-memory, per-function-instance counters per provider (`calls`, `ok`, `responded`, `empty`, `errors`, `timeouts`, `skipped`, `successRate`) plus a ring buffer of the last 100 latencies; `/health.providers` reports nearest-rank p50/p95 for providers with at least one call. Counters reset on cold start, like the stream cache.

## HTTP layer

`src/addon/app.ts` builds an Express app with:

- CORS `*` for `GET, HEAD, OPTIONS`; `OPTIONS` returns 204.
- `GET /manifest.json` and `GET /:config/manifest.json` (5-minute cache), `GET /configure` and `GET /:config/configure` (HTML, 5-minute cache), `GET /stream/:type/:id.json`, `GET /:config/stream/:type/:id.json`, and the non-`.json` variants (`no-store`), `GET /health` (`no-store`).
- Stream requests catch all pipeline errors and return HTTP 200 with `{streams: []}`. Invalid ids short-circuit without touching the network. `HEAD` on a stream route returns 200 without running the pipeline. After the pipeline resolves, `filterStreams` applies the URL segment's user config; an invalid segment yields unfiltered defaults.
- Unknown routes return JSON 404; a final error handler returns JSON 500 only if headers were not sent.

## Vercel deployment shape

- `api/index.ts` calls `getRuntime()` and default-exports the Express app. `api/cron/refresh.ts` verifies `Authorization: Bearer $CRON_SECRET`, calls `snapshots.refresh(true)`, and returns the health report.
- `vercel.json` rewrites `/manifest.json`, `/configure`, `/stream/:path*`, `/health`, `/:config/manifest.json`, `/:config/configure`, and `/:config/stream/:path*` to `/api/index`; sets `buildCommand` to `npm run bake && npm run build`, pins `regions` to `fra1`, sets `maxDuration: 60` and `includeFiles: snapshot/**` for both functions, schedules `/api/cron/refresh` at `0 3 * * *`, and sets `outputDirectory: public`. `/api/cron/refresh` remains a filesystem route and is not matched by these patterns.
- The project must use the **Other** framework preset. The Node preset looks for a root/`src` `app|index|server|main` entrypoint that imports Express and otherwise fails with `No entrypoint found which imports express`; our Express app lives in `src/addon/app.ts`, so the preset is cleared with `vercel project update nuvio-stremio-addon --framework other --yes`.
- `public/` exists only to satisfy the static stage that the Other preset builds alongside `api/` functions.
- The only writable path is `/tmp`, so `NUVIO_CACHE_DIR` defaults to `/tmp/nuvio-addon`. The cron prewarms whichever instance receives it; it cannot warm all instances.
- Vercel adds `x-vercel-id`/`x-invocation-id` tracing headers to outbound `fetch` calls; providers may surface them in returned headers, which then appear in `proxyHeaders`.
- Deployment-specific URLs (`*-<hash>-*.vercel.app`) are protected by Vercel Authentication; public traffic uses the production alias.

## Configuration

All keys are parsed in `src/config.ts`; invalid values abort startup with `ConfigError`. See the table in [README.md](README.md). Notable bounds: `NUVIO_UPDATE_INTERVAL_HOURS` 1-168, `NUVIO_CONCURRENCY` 1-32, `SCRAPER_CONCURRENCY` 1-60, `GLOBAL_DEADLINE_MS` 2000-300000, `STREAM_CACHE_TTL_MS` 0-3600000.

`SCRAPER_SETTINGS_JSON` is `{"<scraperId>": {"key": value}}` and may contain debrid credentials; treat it as a secret. `CRON_SECRET` is generated and stored in Vercel only.

## Failure semantics

| Condition | Result |
| --- | --- |
| Invalid/unknown stream id | 200 `{"streams":[]}` |
| TMDB id not found | 200 `{"streams":[]}`, `nuvio_tmdb_id_missing` log |
| Codeberg unreachable, snapshot active | serves active snapshot (possibly stale) |
| Codeberg unreachable, bundled snapshot present | serves bundled snapshot, `nuvio_snapshot_refresh_failed_using_bundled` log |
| Codeberg unreachable, no snapshot | 200 `{"streams":[]}`, `nuvio_snapshot_unavailable` log |
| Provider download/load failure | provider skipped; snapshot activates if any provider loads |
| Provider throws/timeouts | skipped; other providers' streams returned |
| Global deadline reached | partial results returned |
| Socket closed | request aborted; partial work discarded/cached only if completed |
| Pipeline exception | logged; 200 `{"streams":[]}` |

## Testing

Vitest runs `tests/**/*.test.ts` in Node with a 30 s timeout. All HTTP is local fixture servers (`tests/helpers.ts`); no test touches Codeberg, Cinemeta, or TMDB.

| File | Covers |
| --- | --- |
| `config.test.ts` | defaults, settings parsing, invalid env |
| `codeberg.test.ts` | head/raw fetches, retries on 5xx, no retry on 404, unsafe paths |
| `loader.test.ts` | TMDB key/settings/cheerio injection, `onSettings` defaults, missing `getStreams`, unknown require, supported types |
| `snapshot.test.ts` | download/evaluate/persist/disk reload, bundled load, stale fallback, branch fallback, disabled scrapers |
| `mapStreams.test.ts` | direct mapping, proxy gating, header filtering, subtitles, dedupe/sort, limits |
| `userConfig.test.ts` | segment encode/parse, invalid/versioned defaults, resolution/size/subtitle filtering |
| `pipeline.test.ts` | TMDB resolution, series args, partial results, deadlines, per-provider timeout, caching, single-flight, abort, empty snapshot, request summaries, deadline skips, provider stats |
| `metrics.test.ts` | counters, deadline skips, ring-buffer eviction, nearest-rank percentiles, success rates |
| `routes.test.ts` | manifest, configure page, config-prefixed routes, URL filters, movie/series routes, invalid ids, thrown pipeline, HEAD, health (including provider stats), CORS, 404 |

## Security notes

- Never log or commit `TMDB_API_KEY`, `SCRAPER_SETTINGS_JSON`, `CRON_SECRET`, debrid keys, or cookies. The logger redacts sensitive key names and URL query strings.
- Keep the `require` whitelist narrow; adding modules expands the upstream bundle's in-process capabilities.
- Keep path and size validation before evaluating providers.
- The upstream bundle is third-party code executed without a sandbox; pinning by SHA and reviewing upstream changes are the only safeguards.
- Vercel's AUP prohibits scraping/proxying and Hobby is non-commercial; the deployment risk is accepted by the project owner.
