# Nuvio Stremio Addon

Stremio stream addon that downloads the [eclipsia/nuvio-plugin](https://codeberg.org/eclipsia/nuvio-plugin) scraper bundle and runs its providers server-side. Providers are invoked as `getStreams(tmdbId, "movie"|"tv", season, episode)`; IMDb ids are mapped to TMDB through Cinemeta's `moviedb_id`.

Access is URL-based only: install `https://<deployment>/manifest.json` in Stremio. There is no `/configure` page because all settings are environment-driven.

## Behavior

- `/manifest.json` is static and never calls upstream.
- `/stream/movie/tt...json` and `/stream/series/tt...:S:E.json` resolve TMDB, fan out to enabled providers, and always return HTTP 200.
- Stream URLs are the provider's direct URLs. When `PROXY_ENABLED=true`, provider headers are attached as `behaviorHints.proxyHeaders.request`; the addon never proxies or rewrites media URLs.
- The provider snapshot is downloaded from a pinned Codeberg commit, cached under `NUVIO_CACHE_DIR` (default `/tmp/nuvio-addon` on Vercel), and refreshed at most once per `NUVIO_UPDATE_INTERVAL_HOURS` (default 24). A daily cron force-refreshes the instance it reaches; request-time TTL is the actual freshness guarantee. A stale snapshot is served if upstream is unavailable.

## Environment

Non-secret defaults live in `deploy/vercel.env`; apply them with `scripts/apply-vercel-env.sh` after linking the project.

| Key | Default | Notes |
| --- | --- | --- |
| `NUVIO_SOURCE` | `eclipsia/nuvio-plugin` | `owner/repo` |
| `NUVIO_BRANCH` | `main` | |
| `NUVIO_SHA` | empty | optional commit pin |
| `NUVIO_UPDATE_INTERVAL_HOURS` | `24` | 1-168 |
| `NUVIO_CACHE_DIR` | `$TMPDIR/nuvio-addon` | writable directory |
| `NUVIO_CONCURRENCY` | `8` | provider file downloads |
| `SCRAPER_CONCURRENCY` | `12` | provider fan-out |
| `SCRAPER_TIMEOUT_MS` | `12000` | per provider |
| `GLOBAL_DEADLINE_MS` | `20000` | partial results at deadline |
| `HTTP_TIMEOUT_MS` | `15000` | internal + provider fetch timeout |
| `STREAM_CACHE_TTL_MS` | `60000` | in-memory; 0 disables |
| `TMDB_API_KEY` | empty | optional; providers embed a fallback key |
| `SCRAPER_SETTINGS_JSON` | empty | secret: `{"scraperId":{"key":value}}` |
| `DISABLED_SCRAPERS` | empty | comma-separated ids |
| `PROXY_ENABLED` | `true` | attach `proxyHeaders`; never proxies |
| `CINEMETA_URL` | `https://v3-cinemeta.strem.io` | |
| `TMDB_URL` | `https://api.themoviedb.org/3` | |
| `LOG_LEVEL` | `info` | |
| `CRON_SECRET` | empty | required by the cron endpoint; Vercel sends it automatically |

Example scraper settings:

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

Verification: `npm run typecheck && npm test && npm run build`. Tests use local fixture servers only.

## Deployment

```bash
./scripts/apply-vercel-env.sh
openssl rand -hex 32 | vercel env add CRON_SECRET production
vercel --prod --yes
```

Vercel Git integration deploys pushes to `main`; GitHub Actions runs typecheck, tests, and build. If Git integration is unavailable, use `vercel --prod --yes` from this directory.

## Risks

Provider JavaScript is downloaded and executed in-process with no sandbox. The snapshot is pinned to a Codeberg commit and files are validated by path and size, but the upstream bundle is trusted. Vercel's acceptable-use policy prohibits scraping/proxying and Hobby is non-commercial; this deployment may be suspended. Many provider links require Referer/Cookie headers, so playback may fail when `PROXY_ENABLED=false`.
