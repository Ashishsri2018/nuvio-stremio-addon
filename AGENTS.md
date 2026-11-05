# AGENTS.md

Guidance for AI agents and contributors working in this repository.

## Project

Serverless Stremio stream addon (Node >= 22, ESM TypeScript, Express) that downloads the `eclipsia/nuvio-plugin` scraper bundle from Codeberg and executes its providers in-process. Stremio requests are keyed by IMDb ids; Cinemeta maps them to TMDB ids for `getStreams(tmdbId, "movie"|"tv", season, episode)`.

Read these first:

1. [MEMORY.md](MEMORY.md) — current deployment state, decisions, and known pitfalls.
2. [ARCHITECTURE.md](ARCHITECTURE.md) — request flow, snapshot lifecycle, provider runtime, Vercel shape.

**CI is the source of truth.** GitHub Actions (`.github/workflows/ci.yml`) is authoritative for compile, test, and build results; push and let CI verify rather than treating local runs as the gate. There is no lint script.

## Commands

```bash
npm install
npm run dev        # tsx watch src/local.ts, listens on PORT (default 7000)
npm run typecheck  # tsc over src/ and api/
npm test           # Vitest, tests/**/*.test.ts, no network
npm run build      # tsc -> dist/
npm start          # node dist/src/local.js after build
```

- **CI is the source of truth** for compile and test errors. `.github/workflows/ci.yml` runs `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` on pushes to `main` and PRs. There is no lint or format script; don't assume ESLint/Prettier. Local runs are optional aids, not the gate.
- Tests use local fixture HTTP servers only. Do not add network-dependent tests.
- `typecheck` excludes `tests/`; Vitest is the only check for test files.

## Invariants

- **ESM NodeNext.** Relative imports require `.js` extensions, including in tests (`../src/foo.js`).
- **Stream routes always return HTTP 200.** Invalid ids, unresolvable TMDB ids, missing snapshots, and provider failures return `{"streams":[]}`. Never introduce a 4xx/5xx for a stream request.
- **Direct URLs only.** Provider media URLs are returned untouched. There is no `/proxy` route and no rewriting. `PROXY_ENABLED` only gates `behaviorHints.proxyHeaders.request`.
- **Server config is env-only; per-install filters live in the URL.** All env settings are validated by zod in `src/config.ts`; invalid values abort startup. Per-install stream filters are a base64url JSON path segment (`/<config>/manifest.json`, parsed in `src/addon/userConfig.ts`). Missing or invalid segments fall back to unfiltered defaults and must never cause an error. Nothing is stored server-side.
- **Snapshots are immutable.** Build a complete new snapshot, then swap the in-memory reference. Never mutate loaded scrapers or an active snapshot. Keep disk writes atomic (`src/util/fs.ts`).
- **Use `nativeFetch` for internal HTTP.** Provider code receives the wrapped `fetch` from `src/nuvio/loader.ts`. Do not replace `globalThis.fetch`; internal calls (Codeberg, Cinemeta, TMDB) must use `nativeFetch` from `src/util/nativeFetch.ts`.
- **Keep the `require` whitelist narrow** (`cheerio`, `cheerio-without-node-native`, `crypto-js`). Providers run without a sandbox; adding modules broadens third-party capabilities.
- **Validate upstream paths and sizes** before evaluation (`src/source/codeberg.ts`, `src/nuvio/snapshot.ts`). Keep the path whitelist and size caps.
- **Never log or commit secrets.** `TMDB_API_KEY`, `SCRAPER_SETTINGS_JSON` (may hold debrid keys), `CRON_SECRET`, `.env*`, `.vercel/`, and cookies must stay out of git and structured logs. The logger redacts sensitive key names and URL queries.

## Gotchas

- Provider media types differ: Stremio uses `"series"`, Nuvio expects `"tv"`.
- The user config segment is the first path segment and applies only to response filtering in `src/addon/app.ts`, after the shared, unfiltered pipeline cache. Keep the manifest on both `/manifest.json` and `/:config/manifest.json`, and the configure page on `/configure` and `/:config/configure` (Stremio's gear opens the prefixed one).
- Subtitle languages arrive as display names (`English`, `Brazilian`) from providers but as ISO codes in user config. `LANGUAGE_ALIASES` in `src/addon/userConfig.ts` maps names to codes; keep it updated when new provider language labels appear. `SCRAPER_CONCURRENCY` is capped at 60 in `src/config.ts`.
- Providers read `TMDB_API_KEY` and `SCRAPER_SETTINGS` at module top level. Settings are applied in two passes (`onSettings` defaults first, env overrides win); re-evaluate the module if the merged settings change.
- Some providers accept `supportedTypes: ["series"]`; `scraperSupports` treats `tv` and `series` as equivalent for Stremio series.
- `SCRAPER_TIMEOUT_MS` is a hint; the pipeline's effective per-provider timeout is the remaining `GLOBAL_DEADLINE_MS`.
- The stream cache is in-memory per function instance (`STREAM_CACHE_TTL_MS`, max 500 entries) and is skipped for aborted requests.
- Vercel injects `x-vercel-id`/`x-invocation-id` into outbound fetches; providers may surface them in returned headers, which appear in `proxyHeaders`. This is expected.
- Vercel's writable path is `/tmp` only; `NUVIO_CACHE_DIR` defaults there. Cold instances re-download the snapshot.

## Deployment

Active production: `https://nuvio-stremio-addon-nine.vercel.app` (see MEMORY.md).

- The Vercel project framework preset **must be `Other`**. The Node preset looks for a root/`src` `app|index|server|main` entrypoint importing Express and fails the build otherwise. Do not rename `src/local.ts` back to `src/server.ts`; it is intentionally outside the detected entrypoint names.
- `vercel.json` sets `outputDirectory: "public"` (placeholder `public/.gitkeep`), rewrites `/manifest.json`, `/stream/:path*`, and `/health` to `/api/index`, sets `maxDuration: 60`, and registers the cron `0 3 * * *`.
- `api/index.ts` default-exports the Express app; `api/cron/refresh.ts` checks `Authorization: Bearer $CRON_SECRET` and forces a refresh. Do not add a `builds` array to `vercel.json`; explicit `@vercel/node` builds produced unreachable routes here.
- Non-secret env: edit `deploy/vercel.env` and run `./scripts/apply-vercel-env.sh` (applies one variable at a time; requires a linked project). Secrets are added directly in Vercel; `CRON_SECRET` is stored there and locally at `/root/.nuvio-cron-secret` (never commit).
- Pushing to `main` runs CI and triggers a Vercel production deploy through Git integration. Verify after deploy:
  ```bash
  curl https://nuvio-stremio-addon-nine.vercel.app/manifest.json
  curl -i https://nuvio-stremio-addon-nine.vercel.app/configure
  curl 'https://nuvio-stremio-addon-nine.vercel.app/stream/movie/tt0133093.json'
  curl 'https://nuvio-stremio-addon-nine.vercel.app/stream/series/tt0944947:1:1.json'
  curl https://nuvio-stremio-addon-nine.vercel.app/health
  ```
- Deployment-specific `*.vercel.app` URLs are behind Vercel Authentication (302). Use the production alias for public checks or `vercel curl` for protected URLs.
- Manual fallback: `vercel --prod --yes` from the repo root.

## Risks

- Vercel's AUP prohibits scraping/proxying and Hobby is non-commercial; the deployment may be suspended. The owner explicitly accepted this risk. Do not add multi-account or evasion logic.
- Upstream provider JavaScript is trusted third-party code executed in-process without a sandbox. Pin by commit SHA, keep size/path validation, and review upstream changes when refreshing.
- Direct links often require `Referer`/`Cookie`; with `PROXY_ENABLED=false` those streams may not play.

## Docs

Keep [README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md), [MEMORY.md](MEMORY.md), and this file in sync with behavior and deployment changes. Record new deployment quirks in MEMORY.md with dates; never write secrets there.
