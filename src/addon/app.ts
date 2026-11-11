import express from "express";
import type {
  ErrorRequestHandler,
  Request,
  RequestHandler,
  Response,
} from "express";
import type {
  AppConfig,
  HealthReport,
  LoggerLike,
  StremioStream,
  StremioSubtitle,
} from "../types.js";
import type { StreamPipeline } from "../nuvio/pipeline.js";
import type { SnapshotManager } from "../nuvio/snapshot.js";
import { buildStatus } from "../telemetry.js";
import { renderConfigurePage } from "./configure.js";
import { getManifest } from "./manifest.js";
import { parseStreamId, requestLogFields } from "./parseId.js";
import {
  filterStreams,
  filterSubtitles,
  parseUserConfig,
} from "./userConfig.js";

export interface AppDeps {
  config: AppConfig;
  logger: LoggerLike;
  pipeline: StreamPipeline;
  snapshots: SnapshotManager;
}

async function runStreamRequest(
  req: Request,
  res: Response,
  deps: AppDeps,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "HEAD") {
    res.status(200).end();
    return;
  }

  const request = parseStreamId(req.params.type ?? "", req.params.id ?? "");
  if (!request) {
    res.status(200).json({ streams: [] });
    return;
  }

  const controller = new AbortController();
  const onClose = (): void => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", onClose);

  let streams: StremioStream[] = [];
  try {
    const result = await deps.pipeline.handle(request, controller.signal);
    streams = Array.isArray(result) ? result : [];
  } catch (error) {
    deps.logger.error("stream_request_failed", {
      type: request.type,
      ...requestLogFields(request),
      season: request.season,
      episode: request.episode,
      reason: error instanceof Error ? error.name : "unknown",
    });
  } finally {
    res.off("close", onClose);
  }

  if (res.writableEnded || res.destroyed) return;
  streams = filterStreams(streams, parseUserConfig(req.params.config));
  res.status(200).json({ streams });
}

function createStreamHandler(deps: AppDeps): RequestHandler {
  return (req, res): void => {
    void runStreamRequest(req, res, deps);
  };
}

async function runSubtitleRequest(
  req: Request,
  res: Response,
  deps: AppDeps,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "HEAD") {
    res.status(200).end();
    return;
  }

  // Stremio appends an optional `/<extras>.json` segment to subtitle ids.
  const rawId = Array.isArray(req.params.path) ? req.params.path[0] : req.params.path;
  const request = parseStreamId(req.params.type ?? "", rawId ?? "");
  if (!request) {
    res.status(200).json({ subtitles: [] });
    return;
  }

  const controller = new AbortController();
  const onClose = (): void => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", onClose);

  let subtitles: StremioSubtitle[] = [];
  try {
    subtitles = await deps.pipeline.collectSubtitles(request, controller.signal);
  } catch (error) {
    deps.logger.error("subtitle_request_failed", {
      type: request.type,
      ...requestLogFields(request),
      season: request.season,
      episode: request.episode,
      reason: error instanceof Error ? error.name : "unknown",
    });
  } finally {
    res.off("close", onClose);
  }

  if (res.writableEnded || res.destroyed) return;
  const config = parseUserConfig(req.params.config);
  subtitles = filterSubtitles(subtitles, config.subtitleLangs);
  res.status(200).json({ subtitles });
}

function createSubtitleHandler(deps: AppDeps): RequestHandler {
  return (req, res): void => {
    void runSubtitleRequest(req, res, deps);
  };
}

function buildStatusReport(deps: AppDeps) {
  let health: HealthReport;
  try {
    health = deps.snapshots.getHealth();
  } catch (error) {
    deps.logger.error("health_check_failed", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    health = {
      status: "error",
      sha: null,
      fetchedAt: null,
      scraperCount: 0,
      lastError: "health check failed",
      refreshing: false,
    };
  }

  let providerStats: ReturnType<StreamPipeline["getProviderStats"]> = {};
  try {
    providerStats = deps.pipeline.getProviderStats();
  } catch (error) {
    deps.logger.error("provider_stats_failed", {
      reason: error instanceof Error ? error.name : "unknown",
    });
  }

  let metrics: ReturnType<StreamPipeline["getMetrics"]> | undefined;
  let streamCache: ReturnType<StreamPipeline["getCacheStats"]> | undefined;
  let metadataCache: ReturnType<StreamPipeline["getMetadataCacheStats"]> | null = null;
  try {
    metrics = deps.pipeline.getMetrics?.();
    streamCache = deps.pipeline.getCacheStats?.();
    metadataCache = deps.pipeline.getMetadataCacheStats?.() ?? null;
  } catch (error) {
    deps.logger.error("pipeline_stats_failed", {
      reason: error instanceof Error ? error.name : "unknown",
    });
  }

  return buildStatus({
    addon: "Nuvio Streams",
    status: health.status,
    snapshot: {
      sha: health.sha,
      fetchedAt: health.fetchedAt,
      refreshing: health.refreshing,
      lastError: health.lastError,
    },
    providers: {
      total: health.scraperCount,
      circuits: { open: 0, halfOpen: 0 },
      stats: Object.entries(providerStats).map(([id, stat]) => ({
        id,
        state: "closed",
        calls: stat.calls,
        ok: stat.ok,
        empty: stat.empty,
        errors: stat.errors,
        timeouts: stat.timeouts,
        skipped: stat.skipped,
        successRate: stat.successRate,
        avgMs: stat.p50Ms,
      })),
    },
    cache: {
      stream: streamCache,
      metadata: metadataCache,
    },
    metrics,
  });
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges",
    );
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  const serveRoot: RequestHandler = (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      addon: "community.nuvio.stremio",
      manifest: "/manifest.json",
      configure: "/configure",
      health: "/health",
    });
  };
  app.get("/", serveRoot);

  const serveManifest: RequestHandler = (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(getManifest());
  };
  app.get("/manifest.json", serveManifest);
  app.get("/:config/manifest.json", serveManifest);

  const serveConfigure: RequestHandler = (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("html").send(renderConfigurePage());
  };
  app.get("/configure", serveConfigure);
  app.get("/:config/configure", serveConfigure);

  const streamHandler = createStreamHandler(deps);
  const subtitleHandler = createSubtitleHandler(deps);
  for (const prefix of ["", "/:config"]) {
    app.get(`${prefix}/stream/:type/:id.json`, streamHandler);
    app.get(`${prefix}/stream/:type/:id`, streamHandler);
    app.get(`${prefix}/subtitles/:type/:path*`, subtitleHandler);
  }

  for (const path of ["/health", "/stats"]) {
    app.get(path, (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json(buildStatusReport(deps));
    });
  }

  app.use((req, res) => {
    res.status(404).json({ error: "not found" });
  });

  const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    deps.logger.error("request_failed", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    res.status(500).json({ error: "internal error" });
  };
  app.use(errorHandler);

  return app;
}
