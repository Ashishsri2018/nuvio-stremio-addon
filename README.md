# Nuvio Stremio Addon

Stremio stream addon that downloads the [eclipsia/nuvio-plugin](https://codeberg.org/eclipsia/nuvio-plugin) scraper bundle and runs its providers server-side. Providers are invoked as `getStreams(tmdbId, "movie"|"tv", season, episode)`; IMDb ids are mapped to TMDB through Cinemeta, and `tmdb:` ids pass through directly.

The production install URL is private and intentionally not published. This addon is installed through AIOStreams; the URL is stored only in the Vercel project and the AIOStreams configuration. If you have access to the Vercel project, retrieve it with `vercel project inspect --json` and never commit it.

To filter streams per install, open the deployment's `/configure` page (`$PRODUCTION_URL/configure`) and install the URL it generates (for example, a 720p maximum). Filters travel in the URL; nothing is stored server-side.

## How it works

- `/manifest.json` is static and never calls upstream.
- `/stream/movie/tt...json` and `/stream/series/tt...:S:E.json` resolve the TMDB id, fan out to enabled providers, and always return HTTP 200 (empty `streams` on any failure). `/stream/movie/tmdb:550.json` and `/stream/series/tmdb:1399:S:E.json` skip Cinemeta and use the embedded TMDB id directly.
- `/subtitles/movie/tt...json` and `/subtitles/series/tt...:S:E.json` (also `tmdb:...` forms) aggregate the provider subtitle tracks found for that title (deduped by URL) for clients such as Nuvio Mobile that only query addons declaring a `subtitles` resource. They reuse the stream pipeline and its 3-minute cache.
- Stream URLs are the provider's direct URLs. When `PROXY_ENABLED=true`, provider headers are attached as `behaviorHints.proxyHeaders.request`; the addon never proxies or rewrites media URLs.
- A provider snapshot is downloaded from Codeberg at most once per `NUVIO_UPDATE_INTERVAL_HOURS` (default 24), cached under `NUVIO_CACHE_DIR` (default `/tmp/nuvio-addon` on Vercel), and swapped atomically. A stale snapshot is served if upstream is unavailable.
- Production ships a baked snapshot (`snapshot/`, built by `npm run bake`) so cold instances load providers from disk instead of waiting on Codeberg.
- A daily Vercel cron (`0 3 * * *`) force-refreshes the instance it reaches. Request-time TTL is the actual freshness guarantee; the cron is best-effort prewarming.

## Endpoints

| Route | Behavior |
| --- | --- |
| `GET /` | Small info JSON (`addon`, `manifest`, `configure`, `health`) with `no-store`; used by uptime pingers. |
| `GET /manifest.json` | Static Stremio manifest, `Cache-Control: public, max-age=300`. |
| `GET /:config/manifest.json` | Same manifest under a filter segment. |
| `GET /stream/:type/:id.json` | Movie (`tt...` or `tmdb:...`) or series (`tt...:S:E` or `tmdb:...:S:E`) streams, always HTTP 200, `no-store`. |
| `GET /:config/stream/:type/:id.json` | Same stream route, filtered by the URL segment. |
| `GET /subtitles/:type/:id.json` | Provider subtitle tracks as `{id, url, lang}`, deduped by URL, always HTTP 200. An optional Stremio extras segment (`/<extras>.json`) is accepted and ignored. |
| `GET /:config/subtitles/:type/:id.json` | Same subtitle route under a filter segment. |
| `GET /configure` | HTML page that builds a filtered install URL. |
| `GET /:config/configure` | Same page, prefilled from the segment (Stremio's gear icon). |
| `GET /health` | Snapshot status (`status`, `sha`, `fetchedAt`, `scraperCount`, `lastError`, `refreshing`) plus in-memory per-provider stats (`providers`: calls, responded/empty, errors/timeouts/skips, success rate, p50/p95 latency). Counters reset on cold start. |
| `GET /api/cron/refresh` | Forces a snapshot refresh; requires `Authorization: Bearer $CRON_SECRET`. |

Every GET route also answers `HEAD` with the same status and headers and no body, so uptime pingers such as UptimeRobot can monitor any endpoint.

Invalid ids, unresolvable TMDB ids, missing snapshots, and provider failures all return `{"streams":[]}` (or `{"subtitles":[]}` on subtitle routes) with HTTP 200.

## User configuration

`/configure` offers per-install stream filters. The page encodes them as `{v:1,...}` JSON in base64url and produces `/<segment>/manifest.json`; Stremio then requests `/<segment>/stream/...` and the addon filters the pipeline result before responding. Defaults link to plain `/manifest.json`. An absent or invalid segment falls back to unfiltered defaults and never causes an error. Settings are not stored on the server.

| Filter | Default | Effect |
| --- | --- | --- |
| Maximum resolution | Any | Drops streams whose inferred quality is above the cap (480, 720, 1080, 2160). |
| Minimum resolution | Any | Drops streams below the floor. |
| Include unknown resolution | On | Keeps streams whose quality cannot be inferred. |
| Maximum file size | Any | Drops streams whose title-inferred size exceeds the cap. |
| Include unknown size | On | Keeps streams with no size in the title. |
| Subtitle languages | Any | Filters the `/subtitles` resource to matching tracks. Video streams and inline stream subtitles are never dropped. Codes (`en`, `pt-BR`) also match provider-style names (`English`, `Brazilian`). |

Server-wide env settings (`SCRAPER_SETTINGS_JSON`, `DISABLED_SCRAPERS`, `PROXY_ENABLED`, timeouts) still apply to every request. Per-user filters only trim the response.

## Configuration

Non-secret defaults live in `deploy/vercel.env` and are applied with `scripts/apply-vercel-env.sh`. Secrets are added directly to Vercel and never committed.

| Key | Default | Notes |
| --- | --- | --- |
| `NUVIO_SOURCE` | `eclipsia/nuvio-plugin` | `owner/repo` |
| `NUVIO_BRANCH` | `main` | |
| `NUVIO_SHA` | empty | optional commit pin (SHA-1 or SHA-256) |
| `NUVIO_UPDATE_INTERVAL_HOURS` | `24` | 1-168 |
| `NUVIO_CACHE_DIR` | `$TMPDIR/nuvio-addon` | writable directory |
| `NUVIO_BUNDLED_DIR` | empty | read-only baked snapshot dir (production: `snapshot`) |
| `NUVIO_CONCURRENCY` | `8` | provider file downloads (production uses `16`) |
| `SCRAPER_CONCURRENCY` | `12` | provider fan-out, 1-60 (production uses `60`) |
| `SCRAPER_TIMEOUT_MS` | `12000` | per-provider timeout, capped by `GLOBAL_DEADLINE_MS` |
| `GLOBAL_DEADLINE_MS` | `20000` | partial results at deadline (production uses `30000`) |
| `HTTP_TIMEOUT_MS` | `15000` | internal and provider fetch timeout |
| `STREAM_CACHE_TTL_MS` | `60000` | in-memory; 0 disables (production uses `180000`) |
| `TMDB_API_KEY` | empty | optional; providers embed a fallback key |
| `SCRAPER_SETTINGS_JSON` | empty | secret: `{"scraperId":{"key":value}}` |
| `DISABLED_SCRAPERS` | empty | comma-separated scraper ids |
| `PROXY_ENABLED` | `true` | attach `proxyHeaders`; never proxies |
| `CINEMETA_URL` | `https://v3-cinemeta.strem.io` | |
| `TMDB_URL` | `https://api.themoviedb.org/3` | |
| `LOG_LEVEL` | `info` | redacts token/secret/key/debrid fields |
| `CRON_SECRET` | empty | required by `/api/cron/refresh`; Vercel sends it automatically |
| `PORT` | `7000` | local dev only |

Example `SCRAPER_SETTINGS_JSON` (env overrides win over each provider's `onSettings` defaults):

```json
{
  "jyniq": { "minSeconds": "900" },
  "mavonyx": { "res_2160p": true, "res_1080p": true, "res_720p": false },
  "fjoral": { "cinemaTvToken": "<cookie/token>" },
  "pynvix": { "uiToken": "<FebBox ui cookie>" }
}
```

`fjoral` and `pynvix` return no streams unless their token is set; all other providers work without credentials (43 read `TMDB_API_KEY` but embed a working fallback).

## Local development

```bash
npm install
NUVIO_CACHE_DIR=/tmp/nuvio-test PROXY_ENABLED=true npm run dev
curl localhost:7000/manifest.json
curl localhost:7000/configure
curl 'localhost:7000/stream/movie/tt0133093.json'
curl 'localhost:7000/stream/series/tt0944947:1:1.json'
curl 'localhost:7000/stream/movie/tmdb:550.json'
curl localhost:7000/health
```

`npm run dev` runs `src/local.ts` with `tsx watch`. `npm run build` emits `dist/`; `npm start` runs the built local server. `npm run bake` writes a read-only snapshot to `snapshot/` (gitignored); set `NUVIO_BUNDLED_DIR=snapshot` to serve it without Codeberg.

## Tests and CI

- `npm test` runs Vitest with 96 tests across 10 files. Tests use local fixture HTTP servers only, so they need no network.
- `npm run typecheck` covers `src/` and `api/`; `tests/` are checked by Vitest only.
- GitHub Actions (`.github/workflows/ci.yml`) runs `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` on every push to `main` and every PR. **CI is the source of truth** for compile and test failures.

## Deployment

The Vercel project must use the `Other` framework preset. Vercel's Node preset treats a `server`/`app`/`index` entrypoint as an Express backend and refuses to build the `api/` functions otherwise:

```bash
vercel link                          # select the existing project; do not record its name
vercel project update --framework other --node-version 26.x \
  --no-github-deployment-events --no-git-commit-status --no-git-pr-comments --yes
./scripts/apply-vercel-env.sh
openssl rand -hex 32 | vercel env add CRON_SECRET --environment production
vercel --prod --yes
```

`vercel.json` sets `buildCommand` to `npm run bake && npm run build`, pins functions to the `fra1` region, and sets `outputDirectory` to `public/` (kept via a placeholder file) so the static stage and the `api/` functions build together. The baked `snapshot/` is bundled into both functions via `includeFiles`. `api/index.ts` exports the Express app; `api/cron/refresh.ts` handles the cron. Both run with `maxDuration: 60`.

Vercel Git integration deploys pushes to `main` after CI. Deployment-specific `*.vercel.app` URLs are protected by Vercel Authentication; use the production alias. If Git integration is unavailable, run `vercel --prod --yes`.

The `Refresh bundled snapshot` workflow (`.github/workflows/refresh-snapshot.yml`) runs daily at 04:00 UTC, bakes a fresh snapshot, and triggers a production build through the `nightly-snapshot` Vercel Deploy Hook. The hook URL is stored only as the GitHub Actions secret `VERCEL_DEPLOY_HOOK`; without it the scheduled job still runs `npm run bake` as an upstream health check.

## Operations

```bash
# PRODUCTION_URL is private; retrieve it from the linked Vercel project and never commit it.
export PRODUCTION_URL="https://<private-domain>"
curl "$PRODUCTION_URL/health"
curl -H "Authorization: Bearer $CRON_SECRET" \
  "$PRODUCTION_URL/api/cron/refresh"
vercel logs "$PRODUCTION_URL"
vercel ls
```

A cold function instance loads the baked snapshot from disk in about a second, so the first stream request only pays for provider fan-out (bounded by `GLOBAL_DEADLINE_MS`). If the bundled snapshot is older than `NUVIO_UPDATE_INTERVAL_HOURS`, it is served immediately and Codeberg is refreshed in the background. `/health` reports the active snapshot SHA, scraper count, and per-provider counters. Each stream request logs one `nuvio_streams_resolved` line with cache status, zero-hit/failed/skipped provider ids, the slowest provider, and total duration.

## Limits and failure behavior

- `GLOBAL_DEADLINE_MS` (30 s in production) bounds fan-out; finished providers are returned as partial results.
- At most 20 streams per provider and 300 overall, deduped by URL and sorted by inferred quality.
- Per-install URL filters are applied after the shared pipeline cache, so different filter segments reuse the same upstream results.
- Provider failures are logged and skipped; one bad scraper never fails a request.
- Codeberg outages serve the last cached or bundled snapshot. With no snapshot, streams are empty and the request still returns 200.

## Security and risks

Provider JavaScript is downloaded from Codeberg and executed in-process with `new Function` and no sandbox. The snapshot is pinned to a commit, provider paths and sizes are validated, and only whitelisted modules (`cheerio`, `crypto-js`) can be required, but the upstream bundle is trusted. There is no `/proxy` route and no URL rewriting; `PROXY_ENABLED` only controls `behaviorHints.proxyHeaders`.

Vercel's acceptable-use policy prohibits scraping/proxying and Hobby is non-commercial, so this deployment may be suspended. Many provider links require `Referer`/`Cookie` headers; playback may fail when `PROXY_ENABLED=false`.

See [ARCHITECTURE.md](ARCHITECTURE.md) for internals, [MEMORY.md](MEMORY.md) for current deployment state, and [AGENTS.md](AGENTS.md) for contributor/agent guidance.

## DMCA Notice

We issue this notice to clarify that this repository operate like standard web browsers by retrieving video files from the Internet and do not, by themselves, contravene the Digital Millennium Copyright Act (17 U.S.C. §§ 1201–1205, 17 U.S.C. § 512) or other applicable law. Any content accessed through this addon is provided by third-party websites or file hosts and is not hosted, controlled, or maintained on this repository. Pursuant to the DMCA, copyright owners seeking removal of infringing material should follow the notice-and-takedown procedures set forth in 17 U.S.C. §§ 1201–1205, 17 U.S.C. § 512. If you believe any content accessed via the addon infringed intellectual property rights, please direct your complaints to the hosting websites or file hosts rather than to this repository.
