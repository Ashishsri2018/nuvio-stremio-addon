import type { Express } from "express";
import { createApp } from "./addon/app.js";
import { CinemetaClient } from "./cinemeta/client.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { StreamPipeline } from "./nuvio/pipeline.js";
import { SnapshotManager } from "./nuvio/snapshot.js";
import { CodebergClient } from "./source/codeberg.js";
import type { AppConfig, LoggerLike } from "./types.js";

export interface Runtime {
  config: AppConfig;
  logger: LoggerLike;
  snapshots: SnapshotManager;
  pipeline: StreamPipeline;
  app: Express;
}

export function createRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
  const config = loadConfig(env);
  const logger = createLogger(config.logLevel);
  const source = new CodebergClient({
    source: config.source,
    branch: config.branch,
    logger,
    timeoutMs: config.httpTimeoutMs,
  });
  const snapshots = new SnapshotManager(config, logger, source);
  const cinemeta = new CinemetaClient({ config, logger });
  const pipeline = new StreamPipeline({ config, logger, snapshots, cinemeta });
  const app = createApp({ config, logger, pipeline, snapshots });
  return { config, logger, snapshots, pipeline, app };
}

let cached: Runtime | null = null;

export function getRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
  if (!cached) cached = createRuntime(env);
  return cached;
}
