# Project Memory

Working notes for continuity. Update this file after deployment, configuration, or architecture changes. Facts are as of **2026-11-07**.

## Identity

| Item | Value |
| --- | --- |
| Local path | `/root/iptv/nuvio-stremio-addon` |
| GitHub repo | `https://github.com/Ashishsri2018/nuvio-stremio-addon` (public) |
| Vercel project | linked locally via `.vercel/project.json` (gitignored); name/domain intentionally not recorded |
| Framework preset | **Other** (required, see pitfalls) |
| Vercel Node runtime | 26.x (project default); `package.json` requires >= 22 |
| Upstream source | `eclipsia/nuvio-plugin`, branch `main` |

## Current state

- 2026-11-08: Added the `subtitles` resource (`/subtitles/:type/:id.json` and `/:config/...`). `StreamPipeline.collectSubtitles()` reuses `handle()` so it shares the stream cache/fan-out, flattens inline `stream.subtitles`, and dedupes by URL. Reason: Nuvio Mobile ignores inline stream subtitles and only queries addons declaring a `subtitles` resource. Route uses `/:path*` because Express 4 / path-to-regexp 0.1 has no optional-param groups for the Stremio extras segment. `vercel.json` gained `/subtitles/:path*` and `/:config/subtitles/:path*` rewrites.

- Last code commit verified end-to-end: `10fb616` ("Add /configure page with URL-embedded stream filters").
- GitHub Actions CI passed for that commit (`typecheck`, `test`, `build`, 66 tests) and Vercel deployed it to Production (`Ready`).
- Vercel Git integration is connected: pushes to `main` create production deployments automatically.
- The daily cron `GET /api/cron/refresh` (`0 3 * * *`, maxDuration 60) is registered.
- `/configure` builds per-install filter URLs (max/min resolution, unknown-quality toggle, max size, subtitle languages). Filters are base64url JSON path segments; nothing is stored server-side and invalid segments fall back to defaults.
- 2026-11-05: TODO #7 observability implemented and verified in production (commit `1420c94`; CI success, Vercel Ready). Cold stream request took 19.3 s and returned 30 streams; `/health` reported 48 scrapers (bdix disabled) and populated `providers` stats. `NUVIO_BUNDLED_DIR` was then enabled and verified: activation source `bundled`, pipeline duration 12.3 s (~1 s faster cold) versus 13.4 s via network.
- 2026-11-06: Cold starts now serve the bundled snapshot regardless of age (stale data beats a 6-26 s download) and refresh Codeberg in the background. Added `.github/workflows/refresh-snapshot.yml`, which bakes daily at 04:00 UTC and triggers the `nightly-snapshot` Vercel Deploy Hook; its URL is stored only in the GitHub Actions secret `VERCEL_DEPLOY_HOOK` (set 2026-11-06).
- 2026-11-07: Migrated to a new private Vercel project from the same GitHub repo. The new name/domain are intentionally not stored in any file; retrieve them with `vercel project inspect --json` from the linked project. Vercel GitHub deployment events, commit statuses, and PR comments are disabled so deployment URLs never appear in the public repo. The hook-triggered production deployment is Ready; `/health` reports ok with 48 scrapers, `/api/cron/refresh` returns 200, and public GitHub deployments/statuses/check-runs contain no new-name URLs.
- 2026-11-07: Restored `TMDB_API_KEY` and `SCRAPER_SETTINGS_JSON` (`fjoral`/`pynvix`) in the new project and redeployed. Smoke tests returned 41 movie and 31 series streams; `pynvix` responded 2/2 and `fjoral` 1/2 (one transient 12 s timeout). The old project (`nuvio-stremio-addon`) was deleted after verification; its old URL now returns 404.

## Production environment

Thirteen non-secret variables are configured in Production via `scripts/apply-vercel-env.sh` (including `DISABLED_SCRAPERS` and `NUVIO_BUNDLED_DIR=snapshot`).

`LOG_LEVEL=info`, `NUVIO_SOURCE=eclipsia/nuvio-plugin`, `NUVIO_BRANCH=main`, `NUVIO_UPDATE_INTERVAL_HOURS=24`, `NUVIO_CONCURRENCY=16`, `SCRAPER_CONCURRENCY=60`, `SCRAPER_TIMEOUT_MS=12000`, `GLOBAL_DEADLINE_MS=30000`, `HTTP_TIMEOUT_MS=15000`, `STREAM_CACHE_TTL_MS=180000`, `PROXY_ENABLED=true`, `DISABLED_SCRAPERS=bdix-cf,bdix-df,bdix-fh`.

The bundled snapshot is active in Production: runtime logs show `nuvio_snapshot_activated` with `source:"bundled"`, 48 scrapers, and no Codeberg download on cold stream requests.

Secrets:

- GitHub Actions secret `VERCEL_DEPLOY_HOOK` holds the `nightly-snapshot` deploy hook URL used by the scheduled snapshot workflow. Never print or commit it.
- `CRON_SECRET` is set in Vercel Production. A local copy used for smoke tests lives at `/root/.nuvio-cron-secret` (mode 600, outside the repo). Never commit or echo it.
- `TMDB_API_KEY` is set in Vercel Production; it was validated against the TMDB API before deployment.
- `SCRAPER_SETTINGS_JSON` is set in Vercel Production with `fjoral.cinemaTvToken` (bollywood.eu.org / GramCinema) and `pynvix.uiToken` (FebBox `ui` cookie). Both providers were verified responding after redeploy. Never print or commit the values, and never write them to `deploy/vercel.env`.

## Verified behavior (2026-11-05)

- `/manifest.json` → 200, id `community.nuvio.stremio`, types `movie`/`series`, `behaviorHints.configurable: true`.
- `/configure` → 200 HTML; `/<config>/configure` and `/<config>/manifest.json` → 200.
- URL filter check (2026-11-05): `tt0133093` unfiltered → 51 streams (5×2160p, 24×1080p, 3×720p, 19 unknown); with `maxRes:720` segment `eyJ2IjoxLCJtYXhSZXMiOjcyMH0` → 22 streams (3×720p + 19 unknown), zero above 720p. Invalid segment falls back to the unfiltered response (same 76,652-byte body).
- Subtitle-filter check (2026-11-05): unfiltered `tt0133093` had 49 streams; `maxRes:720` returned 23 with zero >720p. The subtitle language filter previously stripped every track because providers emit `English`/`Urdu`/`Brazilian` while config uses ISO codes; fixed by `LANGUAGE_ALIASES` in `src/addon/userConfig.ts` (full names now match), covered by `tests/userConfig.test.ts`.
- Snapshot activated with **51** scrapers, 51/51 files downloaded (~663 KB), zero load failures.
- Snapshot SHA observed: `5408da4d764564f088d3759e0d01afadfa28a91ce30347be5b00264559a151c6`.
- Movie `tt0133093` (TMDB 603) → 49-54 direct provider streams.
- Series `tt0944947:1:1` (TMDB 1399) → 53 direct streams.
- `behaviorHints.proxyHeaders.request` present with `PROXY_ENABLED=true`; URLs point at provider hosts (0 addon-hosted URLs).
- `/health` → `status: ok`, `scraperCount: 51`, active SHA and `fetchedAt`.
- Cron endpoint: 401 without/with a wrong Bearer token; 200 with the secret and a forced refresh (~9 s). One caveat: the forced refresh re-downloads all provider files even when the head SHA is unchanged.
- Cold stream request with the bundled snapshot: ~12-19 s (provider fan-out; snapshot load is ~1 s). Warm request: bounded by `GLOBAL_DEADLINE_MS` (30 s) plus mapping.
- Note: Vercel instruments outbound `fetch` with `x-vercel-id`/`x-invocation-id`; provider headers surfaced these, so they can appear inside `proxyHeaders`.

## Decisions and rationale

- **Standalone addon, not a Nuvio mirror.** Nuvio's `manifest.json` is not a Stremio manifest; providers must be invoked server-side with TMDB ids.
- **TMDB via Cinemeta first.** Cinemeta's `meta.moviedb_id` avoids a TMDB dependency for most requests; `/find` is only a fallback when `TMDB_API_KEY` exists.
- **Direct URLs + proxyHeaders.** No addon proxy route, no URL rewriting. `PROXY_ENABLED` only gates `behaviorHints.proxyHeaders.request`.
- **`GLOBAL_DEADLINE_MS=30000` (2026-11-05).** Raised from 20 s to 25 s and then 30 s because stream coverage is prioritized over latency. 30 s is the safe ceiling: a slow snapshot download was once ~26 s and 26 + 30 ≈ 56 s, under Vercel's 60 s `maxDuration`. Measured cold TTFB at 25 s was 31-35 s (snapshot ~6-9 s + fan-out); warm uncached ~26-31 s; same-title cache ~1-2 s. Do not exceed 30 s without rechecking cold latency. Each provider call is capped at `min(SCRAPER_TIMEOUT_MS, remaining deadline)`; `HTTP_TIMEOUT_MS=15000` remains per-request.
- **24 h refresh with request-time TTL.** The TTL check in `ensure()` is the guarantee. The Vercel cron is best-effort prewarming because it only reaches one instance.
- **`/tmp` disk cache.** Vercel's only writable path; helps warm instances and avoids re-downloading after a restart within the same instance.
- **Two-pass settings.** Providers read `TMDB_API_KEY`/`SCRAPER_SETTINGS` at top level and optionally expose `onSettings()` defaults; env overrides win.
- **Snapshot swap is atomic and immutable.** A failed refresh leaves the old snapshot active. Never mutate loaded scrapers/snapshots in place.
- **Always HTTP 200 on `/stream`.** Invalid ids, missing TMDB ids, Codeberg outages, and provider failures return `{"streams":[]}`.
- **Language matching normalizes names.** Provider subtitle languages are display names; `userConfig` maps common names to ISO codes (and compares base tags) so `en` matches `English` and `pt` matches `Brazilian Portuguese`.
- **BDIX providers disabled (2026-11-05).** `bdix-cf`, `bdix-df`, and `bdix-fh` target BDIX ISP-internal addresses (`15.1.1.50`, `172.16.50.x`) and `flixhub.net`; they time out from Vercel and normal networks, so they are in `DISABLED_SCRAPERS`.
- **Observability is per-request logs plus per-instance counters (2026-11-05).** `nuvio_streams_resolved` is logged once per request from `StreamPipeline.handle()` with `cache`/`shared`/`outcome`, `zeroHits`, `failed`, `skipped`, `slowest`, and `durationMs`; cache hits reuse stored metadata. `nuvio_snapshot_activated` carries `source` (`disk`/`bundled`/`network`). `/health.providers` reports counters and nearest-rank p50/p95 from a 100-sample ring buffer; stats reset on cold start. Test count is now 85.
- **Bundled snapshot is the cold-start baseline (2026-11-06).** `npm run bake` writes `snapshot/` at build time and Vercel ships it via `includeFiles`; runtime prefers it over any network download, serves stale copies immediately, and refreshes in the background. Codeberg remains the source for refreshes and the fallback path is inverted (bundled first, network on failure) to remove cold-start latency and outage sensitivity. A scheduled GitHub Actions job rebakes daily and redeploys through a deploy hook.
- **Stream cache TTL is 3 minutes (2026-11-06).** Production `STREAM_CACHE_TTL_MS=180000` (was `60000`) to cut repeat fan-outs; `GLOBAL_DEADLINE_MS` stays at 30 s because Vercel caps functions at 60 s.
- **Per-user filters via URL segment, vega-style.** `/<config>/manifest.json` carries a validated base64url JSON config; filtering runs in the route after the shared pipeline cache, so upstream work is never duplicated per user. Manifests are also served at `/manifest.json` (defaults) and the gear opens `/<config>/configure`.

## Deployment pitfalls already hit and fixed

1. `vercel link` created the project but `vercel git connect` failed with "You need to add a Login Connection". The owner connected GitHub; `vercel git connect` then reported the repo already connected, and pushes deploy.
2. Zero-config deploy failed with `No entrypoint found which imports express. Found possible entrypoint: src/server.ts`. Vercel's Node preset treats root/`src` `app|index|server|main` files as Express backends and expects a direct `express` import; our Express app is in `src/addon/app.ts`.
3. Renaming `src/server.ts` to `src/local.ts` changed the error to `No entrypoint found` (the Node preset always requires a server entrypoint). Removing the `start` script did not help.
4. Setting `"framework": null` in `vercel.json` switched to a static build and failed with `STATIC_BUILD_NO_OUT_DIR`.
5. Explicit `builds: [{ use: "@vercel/node" }]` built functions but produced a config without reachable routes; `/manifest.json` and `/api/index` 404'd.
6. The working fix: set the project framework preset to `other` (`vercel project update --framework other --yes` against the linked project), set `"outputDirectory": "public"` in `vercel.json`, and keep a placeholder `public/.gitkeep`. Functions are emitted as `api/index.func` and `api/cron/refresh.func` and the rewrites resolve.
7. Deployment-specific `*.vercel.app` URLs are protected by Vercel Authentication (302 to `sso-api`). Use the private production alias for public checks; `vercel curl` bypasses protection. The alias is not recorded in this repo.

## Open follow-ups

- `SCRAPER_SETTINGS_JSON` now carries the `fjoral`/`pynvix` credentials; add preference toggles (jyniq, mavonyx, etc.) and `DISABLED_SCRAPERS` as needed.
- Monitor the Vercel AUP risk: scraping/proxying is prohibited and Hobby is non-commercial. The owner explicitly accepted this risk.
- If Vercel disables the deploy hook, recreate it and update the `VERCEL_DEPLOY_HOOK` GitHub secret; the scheduled job still bakes without it.
- No lint/format tooling exists by design; CI runs typecheck, tests, and build only.

## Update protocol

- Keep [README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md), and [AGENTS.md](AGENTS.md) in sync with code and deployment changes.
- Record new deployment quirks here with dates.
- Never store secrets in this file; refer to their location instead.
