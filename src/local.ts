import { getRuntime } from "./runtime.js";

const runtime = getRuntime();

process.on("unhandledRejection", (reason) => {
  runtime.logger.error("unhandled_rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});
process.on("uncaughtException", (error) => {
  runtime.logger.error("uncaught_exception", { error: error.message });
});

const server = runtime.app.listen(runtime.config.port, () => {
  runtime.logger.info("server_started", {
    port: runtime.config.port,
    cacheDir: runtime.config.cacheDir,
    source: runtime.config.source,
  });
});

const shutdown = (signal: string): void => {
  runtime.logger.info("shutdown_started", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
