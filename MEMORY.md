# Project Memory

Working notes for continuity. Update this file after deployment, configuration, or architecture changes. Facts are as of **2026-11-05**.

## Identity

| Item | Value |
| --- | --- |
| Local path | `/root/iptv/nuvio-stremio-addon` |
| GitHub repo | `https://github.com/Ashishsri2018/nuvio-stremio-addon` (public) |
| Vercel project | `ashishsri2018-7679s-projects/nuvio-stremio-addon` |
| Vercel project id | `prj_TN1aeAtSdDRDSFUWFqA7w5gplUI4` |
| Production URL | `https://nuvio-stremio-addon-nine.vercel.app` |
| Install URL | `https://nuvio-stremio-addon-nine.vercel.app/manifest.json` |
| Configure page | `https://nuvio-stremio-addon-nine.vercel.app/configure` (per-install filters in the URL) |
| Framework preset | **Other** (required, see pitfalls) |
| Vercel Node runtime | 26.x (project default); `package.json` requires >= 22 |
| Upstream source | `eclipsia/nuvio-plugin`, branch `main` |

## Current state

- Last code commit verified end-to-end: `10fb616` ("Add /configure page with URL-embedded stream filters").
- GitHub Actions CI passed for that commit (`typecheck`, `test`, `build`, 64 tests) and Vercel deployed it to Production (`Ready`).
- Vercel Git integration is connected: pushes to `main` create production deployments automatically.
- The daily cron `GET /api/cron/refresh` (`0 3 * * *`, maxDuration 60) is registered.
- `/configure` builds per-install filter URLs (max/min resolution, unknown-quality toggle, max size, subtitle languages). Filters are base64url JSON path segments; nothing is stored server-side and invalid segments fall back to defaults.

## Production environment

Eleven non-secret variables from `deploy/vercel.env` were applied to Production with `scripts/apply-vercel-env.sh`:

`LOG_LEVEL=info`, `NUVIO_SOURCE=eclipsia/nuvio-plugin`, `NUVIO_BRANCH=main`, `NUVIO_UPDATE_INTERVAL_HOURS=24`, `NUVIO_CONCURRENCY=8`, `SCRAPER_CONCURRENCY=12`, `SCRAPER_TIMEOUT_MS=12000`, `GLOBAL_DEADLINE_MS=20000`, `HTTP_TIMEOUT_MS=15000`, `STREAM_CACHE_TTL_MS=60000`, `PROXY_ENABLED=true`.

Secrets:

- `CRON_SECRET` is set in Vercel Production. A local copy used for smoke tests lives at `/root/.nuvio-cron-secret` (mode 600, outside the repo). Never commit or echo it.
- `TMDB_API_KEY` is **not** set; providers use their embedded fallback key.
- `SCRAPER_SETTINGS_JSON` is **not** set; provider defaults are in effect.

## Verified behavior (2026-11-05)

- `/manifest.json` → 200, id `community.nuvio.stremio`, types `movie`/`series`, `behaviorHints.configurable: true`.
- `/configure` → 200 HTML; `/<config>/configure` and `/<config>/manifest.json` → 200.
- URL filter check (2026-11-05): `tt0133093` unfiltered → 51 streams (5×2160p, 24×1080p, 3×720p, 19 unknown); with `maxRes:720` segment `eyJ2IjoxLCJtYXhSZXMiOjcyMH0` → 22 streams (3×720p + 19 unknown), zero above 720p. Invalid segment falls back to the unfiltered response (same 76,652-byte body).
- Snapshot activated with **51** scrapers, 51/51 files downloaded (~663 KB), zero load failures.
- Snapshot SHA observed: `5408da4d764564f088d3759e0d01afadfa28a91ce30347be5b00264559a151c6`.
- Movie `tt0133093` (TMDB 603) → 49-54 direct provider streams.
- Series `tt0944947:1:1` (TMDB 1399) → 53 direct streams.
- `behaviorHints.proxyHeaders.request` present with `PROXY_ENABLED=true`; URLs point at provider hosts (0 addon-hosted URLs).
- `/health` → `status: ok`, `scraperCount: 51`, active SHA and `fetchedAt`.
- Cron endpoint: 401 without/with a wrong Bearer token; 200 with the secret and a forced refresh (~9 s). One caveat: the forced refresh re-downloads all provider files even when the head SHA is unchanged.
- Cold stream request: ~26-28 s (snapshot download + fan-out). Warm request: bounded by `GLOBAL_DEADLINE_MS` (20 s) plus mapping.
- Note: Vercel instruments outbound `fetch` with `x-vercel-id`/`x-invocation-id`; provider headers surfaced these, so they can appear inside `proxyHeaders`.

## Decisions and rationale

- **Standalone addon, not a Nuvio mirror.** Nuvio's `manifest.json` is not a Stremio manifest; providers must be invoked server-side with TMDB ids.
- **TMDB via Cinemeta first.** Cinemeta's `meta.moviedb_id` avoids a TMDB dependency for most requests; `/find` is only a fallback when `TMDB_API_KEY` exists.
- **Direct URLs + proxyHeaders.** No addon proxy route, no URL rewriting. `PROXY_ENABLED` only gates `behaviorHints.proxyHeaders.request`.
- **24 h refresh with request-time TTL.** The TTL check in `ensure()` is the guarantee. The Vercel cron is best-effort prewarming because it only reaches one instance.
- **`/tmp` disk cache.** Vercel's only writable path; helps warm instances and avoids re-downloading after a restart within the same instance.
- **Two-pass settings.** Providers read `TMDB_API_KEY`/`SCRAPER_SETTINGS` at top level and optionally expose `onSettings()` defaults; env overrides win.
- **Snapshot swap is atomic and immutable.** A failed refresh leaves the old snapshot active. Never mutate loaded scrapers/snapshots in place.
- **Always HTTP 200 on `/stream`.** Invalid ids, missing TMDB ids, Codeberg outages, and provider failures return `{"streams":[]}`.
- **Per-user filters via URL segment, vega-style.** `/<config>/manifest.json` carries a validated base64url JSON config; filtering runs in the route after the shared pipeline cache, so upstream work is never duplicated per user. Manifests are also served at `/manifest.json` (defaults) and the gear opens `/<config>/configure`.

## Deployment pitfalls already hit and fixed

1. `vercel link` created the project but `vercel git connect` failed with "You need to add a Login Connection". The owner connected GitHub; `vercel git connect` then reported the repo already connected, and pushes deploy.
2. Zero-config deploy failed with `No entrypoint found which imports express. Found possible entrypoint: src/server.ts`. Vercel's Node preset treats root/`src` `app|index|server|main` files as Express backends and expects a direct `express` import; our Express app is in `src/addon/app.ts`.
3. Renaming `src/server.ts` to `src/local.ts` changed the error to `No entrypoint found` (the Node preset always requires a server entrypoint). Removing the `start` script did not help.
4. Setting `"framework": null` in `vercel.json` switched to a static build and failed with `STATIC_BUILD_NO_OUT_DIR`.
5. Explicit `builds: [{ use: "@vercel/node" }]` built functions but produced a config without reachable routes; `/manifest.json` and `/api/index` 404'd.
6. The working fix: set the project framework preset to `other` (`vercel project update nuvio-stremio-addon --framework other --yes`), set `"outputDirectory": "public"` in `vercel.json`, and keep a placeholder `public/.gitkeep`. Functions are emitted as `api/index.func` and `api/cron/refresh.func` and the rewrites resolve.
7. Deployment-specific `*.vercel.app` URLs are protected by Vercel Authentication (302 to `sso-api`). Use `https://nuvio-stremio-addon-nine.vercel.app` for public checks; `vercel curl` bypasses protection.

## Open follow-ups

- Optionally set `TMDB_API_KEY` in Vercel (recommended if the embedded fallback key is rate-limited).
- Optionally set `SCRAPER_SETTINGS_JSON` for provider toggles (jyniq, mavonyx, etc.) and `DISABLED_SCRAPERS` for noisy providers.
- Monitor the Vercel AUP risk: scraping/proxying is prohibited and Hobby is non-commercial. The owner explicitly accepted this risk.
- Cold instances always re-download the snapshot; if latency becomes a problem, consider a longer `STREAM_CACHE_TTL_MS` or an external cache, not a larger `GLOBAL_DEADLINE_MS` (Vercel caps at 60 s).
- `SCRAPER_TIMEOUT_MS` is currently a configuration hint; the pipeline's effective per-provider timeout is the remaining global deadline.
- No lint/format tooling exists by design; CI runs typecheck, tests, and build only.

## Update protocol

- Keep [README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md), and [AGENTS.md](AGENTS.md) in sync with code and deployment changes.
- Record new deployment quirks here with dates.
- Never store secrets in this file; refer to their location instead.
