// ============================================================================
// SITREP — Structured Logger (pino)
// ============================================================================
// JSON in prod (machine-parseable for Loki/Grafana), pretty in dev.
// Usage: const log = require("./lib/logger");
//        log.info({ target: "capipilot-api", latency: 42 }, "health check OK");
// ============================================================================

const pino = require("pino");

const IS_DEV = process.env.NODE_ENV !== "production";

const logger = pino({
  level: process.env.LOG_LEVEL || (IS_DEV ? "debug" : "info"),
  ...(IS_DEV
    ? {
        transport: {
          target: "pino/file",
          options: { destination: 1 }, // stdout
        },
        // Pretty-ish output in dev without needing pino-pretty
        formatters: {
          level(label) { return { level: label }; },
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      }
    : {
        // Prod: pure JSON, no overhead
        formatters: {
          level(label) { return { level: label }; },
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      }),
  name: "sitrep",
});

module.exports = logger;
