# Nuvio Stremio Addon

Stremio stream addon that downloads the [eclipsia/nuvio-plugin](https://codeberg.org/eclipsia/nuvio-plugin) scraper bundle and runs its providers server-side. Providers are invoked as `getStreams(tmdbId, "movie"|"tv", season, episode)`; Stremio's IMDb ids are mapped to TMDB through Cinemeta.

Install: `https://nuvio-stremio-addon-nine.vercel.app/manifest.json`

There is no `/configure` page. All settings are environment-driven.

## How it works

- `/manifest.json` is static and never calls upstream.
- `/stream/movie/tt...json` and `/stream/series/tt...:S:E.json` resolve the TMDB id, fan out to enabled providers, and always return HTTP 200 (empty `streams` on any failure).
- Stream URLs are the provider's direct URLs. When `PROXY_ENABLED=true`, provider headers are attached as `behaviorHints.proxyHeaders.request`; the addon never proxies or rewrites media URLs.
- A provider snapshot is downloaded from Codeberg at most once per `NUVIO_UPDATE_INTERVAL_HOURS` (default 24), cached under `NUVIO_CACHE_DIR` (default `/tmp/nuvio-addon` on Vercel), and swapped atomically. A stale snapshot is served if upstream is unavailable.
- A daily Vercel cron (`0 3 * * *`) force-refreshes the instance it reaches. Request-time TTL is the actual freshness guarantee; the cron is best-effort prewarming.

## Endpoints

| Route | Behavior |
| --- | --- |
| `GET /manifest.json` | Static Stremio manifest, `Cache-Control: public, max-age=300`. |
| `GET /stream/:type/:id.json` | Movie (`tt...`) or series (`tt...:S:E`) streams, always HTTP 200, `no-store`. |
| `GET /health` | Snapshot status: `status`, `sha`, `fetchedAt`, `scraperCount`, `lastError`, `refreshing`. |
| `GET /api/cron/refresh` | Forces a snapshot refresh; requires `Authorization: Bearer $CRON_SECRET`. |

Invalid ids, unresolvable TMDB ids, missing snapshots, and provider failures all return `{"streams":[]}` with HTTP 200.

## Configuration

Non-secret defaults live in `deploy/vercel.env` and are applied with `scripts/apply-vercel-env.sh`. Secrets are added directly to Vercel and never committed.

| Key | Default | Notes |
| --- | --- | --- |
| `NUVIO_SOURCE` | `eclipsia/nuvio-plugin` | `owner/repo` |
| `NUVIO_BRANCH` | `main` | |
| `NUVIO_SHA` | empty | optional commit pin |
| `NUVIO_UPDATE_INTERVAL_HOURS` | `24` | 1-168 |
| `NUVIO_CACHE_DIR` | `$TMPDIR/nuvio-addon` | writable directory |
| `NUVIO_CONCURRENCY` | `8` | provider file downloads |
| `SCRAPER_CONCURRENCY` | `12` | provider fan-out |
| `SCRAPER_TIMEOUT_MS` | `12000` | per provider deadline hint |
| `GLOBAL_DEADLINE_MS` | `20000` | partial results at deadline |
| `HTTP_TIMEOUT_MS` | `15000` | internal and provider fetch timeout |
| `STREAM_CACHE_TTL_MS` | `60000` | in-memory; 0 disables |
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
  "mavonyx": { "res_2160p": true, "res_1080p": true, "res_720p": false }
}
```

## Local development

```bash
npm install
NUVIO_CACHE_DIR=/tmp/nuvio-test PROXY_ENABLED=true npm run dev
curl localhost:7000/manifest.json
curl 'localhost:7000/stream/movie/tt0133093.json'
curl 'localhost:7000/stream/series/tt0944947:1:1.json'
curl localhost:7000/health
```

`npm run dev` runs `src/local.ts` with `tsx watch`. `npm run build` emits `dist/`; `npm start` runs the built local server.

## Tests and CI

- `npm test` runs Vitest with 41 tests across 7 files. Tests use local fixture HTTP servers only, so they need no network.
- `npm run typecheck` covers `src/` and `api/`; `tests/` are checked by Vitest only.
- GitHub Actions (`.github/workflows/ci.yml`) runs `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` on every push to `main` and every PR. **CI is the source of truth** for compile and test failures.

## Deployment

The Vercel project must use the `Other` framework preset. Vercel's Node preset treats a `server`/`app`/`index` entrypoint as an Express backend and refuses to build the `api/` functions otherwise:

```bash
vercel link --yes --project nuvio-stremio-addon
vercel project update nuvio-stremio-addon --framework other --yes
./scripts/apply-vercel-env.sh
openssl rand -hex 32 | vercel env add CRON_SECRET production
vercel --prod --yes
```

`vercel.json` sets `outputDirectory` to `public/` (kept via a placeholder file) so the static stage and the `api/` functions build together. `api/index.ts` exports the Express app; `api/cron/refresh.ts` handles the cron. Both run with `maxDuration: 60`.

Vercel Git integration deploys pushes to `main` after CI. Deployment-specific `*.vercel.app` URLs are protected by Vercel Authentication; use the production alias. If Git integration is unavailable, run `vercel --prod --yes`.

## Operations

```bash
curl https://nuvio-stremio-addon-nine.vercel.app/health
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://nuvio-stremio-addon-nine.vercel.app/api/cron/refresh
vercel logs https://nuvio-stremio-addon-nine.vercel.app
vercel ls
```

A cold function instance re-downloads the 51-provider snapshot, so the first stream request takes roughly 25-30 seconds. Warm requests finish at the global deadline or sooner. `/health` reports the active snapshot SHA and scraper count.

## Limits and failure behavior

- `GLOBAL_DEADLINE_MS` (20 s) bounds fan-out; finished providers are returned as partial results.
- At most 20 streams per provider and 300 overall, deduped by URL and sorted by inferred quality.
- Provider failures are logged and skipped; one bad scraper never fails a request.
- Codeberg outages serve the last cached snapshot. With no snapshot, streams are empty and the request still returns 200.

## Security and risks

Provider JavaScript is downloaded from Codeberg and executed in-process with `new Function` and no sandbox. The snapshot is pinned to a commit, provider paths and sizes are validated, and only whitelisted modules (`cheerio`, `crypto-js`) can be required, but the upstream bundle is trusted. There is no `/proxy` route and no URL rewriting; `PROXY_ENABLED` only controls `behaviorHints.proxyHeaders`.

Vercel's acceptable-use policy prohibits scraping/proxying and Hobby is non-commercial, so this deployment may be suspended. Many provider links require `Referer`/`Cookie` headers; playback may fail when `PROXY_ENABLED=false`.

See [ARCHITECTURE.md](ARCHITECTURE.md) for internals, [MEMORY.md](MEMORY.md) for current deployment state, and [AGENTS.md](AGENTS.md) for contributor/agent guidance.
