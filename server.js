// ============================================================================
// SITREP — Tactical Ops Dashboard
// ============================================================================
// Real-time health monitoring for all production assets.
// No external dependencies except express.
// ============================================================================

const express = require("express");
const path = require("path");
const { TARGETS } = require("./config");

const app = express();
const PORT = process.env.PORT || 3333;

app.use(express.static(path.join(__dirname, "public")));

// ── Health check cache ──────────────────────────────────────────────────────
const cache = new Map();
const POLL_INTERVAL = process.env.POLL_INTERVAL || 30_000; // 30s

async function checkTarget(target) {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), target.timeout || 8000);

  try {
    const res = await fetch(target.url, {
      signal: controller.signal,
      headers: { "User-Agent": "SITREP/1.0" },
      redirect: "follow",
    });
    clearTimeout(timeout);
    const latency = Date.now() - start;
    const status = res.ok ? "OPERATIONAL" : "DEGRADED";

    // Try to read body for extra info (Spring actuator returns JSON)
    let details = null;
    try {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("json")) {
        details = await res.json();
      }
    } catch {
      // ignore
    }

    return {
      id: target.id,
      status,
      httpCode: res.status,
      latency,
      details,
      lastCheck: new Date().toISOString(),
      error: null,
    };
  } catch (err) {
    clearTimeout(timeout);
    const latency = Date.now() - start;
    return {
      id: target.id,
      status: "DOWN",
      httpCode: null,
      latency,
      details: null,
      lastCheck: new Date().toISOString(),
      error: err.name === "AbortError" ? "TIMEOUT" : err.message,
    };
  }
}

async function pollAll() {
  const results = await Promise.allSettled(
    TARGETS.map((t) => checkTarget(t))
  );
  for (const r of results) {
    if (r.status === "fulfilled") {
      const prev = cache.get(r.value.id);
      // Track status transitions
      if (prev && prev.status !== r.value.status) {
        r.value.transition = {
          from: prev.status,
          to: r.value.status,
          at: new Date().toISOString(),
        };
      }
      cache.set(r.value.id, r.value);
    }
  }
}

// ── API ─────────────────────────────────────────────────────────────────────

app.get("/api/status", (_req, res) => {
  const targets = TARGETS.map((t) => {
    const check = cache.get(t.id) || {
      id: t.id,
      status: "UNKNOWN",
      httpCode: null,
      latency: null,
      details: null,
      lastCheck: null,
      error: "PENDING_FIRST_CHECK",
    };
    return {
      ...check,
      name: t.name,
      group: t.group,
      url: t.url,
      type: t.type,
      icon: t.icon,
    };
  });

  const summary = {
    total: targets.length,
    operational: targets.filter((t) => t.status === "OPERATIONAL").length,
    degraded: targets.filter((t) => t.status === "DEGRADED").length,
    down: targets.filter((t) => t.status === "DOWN").length,
    unknown: targets.filter((t) => t.status === "UNKNOWN").length,
  };

  res.json({
    timestamp: new Date().toISOString(),
    pollInterval: POLL_INTERVAL,
    summary,
    targets,
  });
});

// Force immediate re-check
app.post("/api/status/refresh", async (_req, res) => {
  await pollAll();
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║         S I T R E P   O N L I N E           ║
  ║     Tactical Ops Dashboard v1.0.0           ║
  ║     http://localhost:${PORT}                   ║
  ╚══════════════════════════════════════════════╝
  `);
  console.log(`[SITREP] Monitoring ${TARGETS.length} targets every ${POLL_INTERVAL / 1000}s`);
  pollAll(); // first check immediately
  setInterval(pollAll, POLL_INTERVAL);
});
