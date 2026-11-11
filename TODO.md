# TODO

Planned improvements not yet implemented. Newest work first.

## Completed
- [x] Web page detection and `externalUrl` mapping: classify stream URLs, map web embeds and archives to Stremio `externalUrl`, drop `/slowdown` blockers, and sort direct streams first.

## 3. Per-provider health tracking and circuit breaking

Today only `DISABLED_SCRAPERS` (manual, env-wide) removes a provider. A bad provider still costs latency on every request until someone notices.

- Track per scraper id: invocations, non-empty responses, empty responses, errors, timeouts, last error, EWMA latency.
- Keep stats in memory per function instance (matches the existing stream cache model); expose them via `/health` behind a compact summary (do not leak stream URLs or credentials).
- Add a circuit breaker: after N consecutive failures/timeouts (e.g. 3), skip that provider for a cooldown window (e.g. 10 minutes) and log `nuvio_scraper_circuit_open`.
- Emit a structured `nuvio_streams_resolved` summary that includes zero-hit provider ids for observability.
- Acceptance: a provider that always throws is skipped after the threshold; `/health` shows counters; existing pipeline tests still pass.

Likely files: `src/nuvio/pipeline.ts`, `src/types.ts`, `src/addon/app.ts`, `tests/pipeline.test.ts`.

## 4. Per-install provider selection

The URL config segment currently filters only the response (`maxRes`, `minRes`, size, subtitle languages). Add provider include/exclude lists so users can skip dead, slow, or irrelevant scrapers.

- Extend `src/addon/userConfig.ts` schema with optional `providers` / `excludeProviders` (scraper ids, validated with the same `[A-Za-z0-9_.-]+` pattern as `DISABLED_SCRAPERS`).
- Apply after the shared pipeline result, before quality/size/subtitle filters. Do not add provider selection to the shared pipeline cache key, or each config would duplicate upstream work.
- Update `/configure` with a provider list (from the manifest) and keep the page working without server state.
- Acceptance: `/<segment>/stream/...` only includes the selected provider names; invalid/missing segments behave as today.

Likely files: `src/addon/userConfig.ts`, `src/addon/configure.ts`, `src/addon/app.ts`, `tests/userConfig.test.ts`, `tests/routes.test.ts`.
