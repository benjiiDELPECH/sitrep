// ============================================================================
// SITREP — Tactical Ops Dashboard v2.0
// ============================================================================
// Real-time health monitoring for all production assets.
// Features: health polling, uptime tracking, latency history, SSL cert expiry,
//           incident log persistence, Discord webhook alerts.
// ============================================================================

const express = require("express");
const path = require("path");
const tls = require("tls");
const { TARGETS } = require("./config");

const app = express();
const PORT = process.env.PORT || 3333;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || null;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ── Health check cache ──────────────────────────────────────────────────────
const cache = new Map();
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL) || 30_000;

// ── Latency history (last 30 data points per target) ────────────────────────
const latencyHistory = new Map(); // id → number[]
const HISTORY_SIZE = 30;

// ── Uptime tracking (rolling 24h window) ────────────────────────────────────
const uptimeChecks = new Map(); // id → { up: number, total: number, since: ISO }

// ── Incident log (server-side, last 200 entries) ────────────────────────────
const incidents = [];
const MAX_INCIDENTS = 200;

function addIncident(target, from, to) {
  const entry = {
    id: target.id,
    name: target.name,
    group: target.group,
    icon: target.icon,
    from,
    to,
    at: new Date().toISOString(),
  };
  incidents.unshift(entry);
  if (incidents.length > MAX_INCIDENTS) incidents.pop();

  // Discord webhook
  if (DISCORD_WEBHOOK) sendDiscordAlert(entry).catch(() => {});
}

// ── Discord webhook ─────────────────────────────────────────────────────────
async function sendDiscordAlert(incident) {
  const color = incident.to === "DOWN" ? 0xff3333
    : incident.to === "DEGRADED" ? 0xffaa00
    : 0x00ff41;
  const emoji = incident.to === "DOWN" ? "🔴"
    : incident.to === "DEGRADED" ? "🟡"
    : "🟢";

  const embed = {
    title: `${emoji} ${incident.name}`,
    description: `**${incident.from}** → **${incident.to}**`,
    color,
    fields: [
      { name: "Group", value: incident.group, inline: true },
      { name: "Time", value: `<t:${Math.floor(Date.now() / 1000)}:T>`, inline: true },
    ],
    footer: { text: "SITREP — Tactical Ops Dashboard" },
    timestamp: incident.at,
  };

  await fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });
}

// ── SSL Certificate Check ───────────────────────────────────────────────────
const certCache = new Map(); // hostname → { validTo, daysLeft, issuer, checkedAt }
const CERT_CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6h

function checkCert(hostname) {
  return new Promise((resolve) => {
    const socket = tls.connect(443, hostname, { servername: hostname }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.valid_to) return resolve(null);

      const validTo = new Date(cert.valid_to);
      const daysLeft = Math.floor((validTo - Date.now()) / 86400000);
      resolve({
        hostname,
        validTo: validTo.toISOString(),
        daysLeft,
        issuer: cert.issuer?.O || cert.issuer?.CN || "Unknown",
        subject: cert.subject?.CN || hostname,
        checkedAt: new Date().toISOString(),
      });
    });
    socket.setTimeout(5000, () => { socket.destroy(); resolve(null); });
    socket.on("error", () => resolve(null));
  });
}

async function pollCerts() {
  const hostnames = [...new Set(
    TARGETS
      .filter((t) => t.url.startsWith("https://"))
      .map((t) => new URL(t.url).hostname)
  )];

  for (const h of hostnames) {
    const info = await checkCert(h);
    if (info) certCache.set(h, info);
  }
  console.log(`[SITREP] SSL certs checked: ${certCache.size} certs`);
}

// ── Health check ────────────────────────────────────────────────────────────
async function checkTarget(target) {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), target.timeout || 8000);

  try {
    const res = await fetch(target.url, {
      signal: controller.signal,
      headers: { "User-Agent": "SITREP/2.0" },
      redirect: "follow",
    });
    clearTimeout(timeout);
    const latency = Date.now() - start;
    const status = res.ok ? "OPERATIONAL" : "DEGRADED";

    let details = null;
    try {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("json")) details = await res.json();
    } catch { /* ignore */ }

    return { id: target.id, status, httpCode: res.status, latency, details, lastCheck: new Date().toISOString(), error: null };
  } catch (err) {
    clearTimeout(timeout);
    return {
      id: target.id, status: "DOWN", httpCode: null,
      latency: Date.now() - start, details: null,
      lastCheck: new Date().toISOString(),
      error: err.name === "AbortError" ? "TIMEOUT" : err.message,
    };
  }
}

async function pollAll() {
  const results = await Promise.allSettled(TARGETS.map((t) => checkTarget(t)));

  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const val = r.value;
    const prev = cache.get(val.id);

    // Status transition detection
    if (prev && prev.status !== val.status) {
      val.transition = { from: prev.status, to: val.status, at: new Date().toISOString() };
      const target = TARGETS.find((t) => t.id === val.id);
      if (target) addIncident(target, prev.status, val.status);
    }
    cache.set(val.id, val);

    // Latency history
    if (!latencyHistory.has(val.id)) latencyHistory.set(val.id, []);
    const hist = latencyHistory.get(val.id);
    hist.push(val.latency || 0);
    if (hist.length > HISTORY_SIZE) hist.shift();

    // Uptime tracking
    if (!uptimeChecks.has(val.id)) {
      uptimeChecks.set(val.id, { up: 0, total: 0, since: new Date().toISOString() });
    }
    const ut = uptimeChecks.get(val.id);
    ut.total++;
    if (val.status === "OPERATIONAL") ut.up++;
  }
}

// ── API ─────────────────────────────────────────────────────────────────────

app.get("/api/status", (_req, res) => {
  const targets = TARGETS.map((t) => {
    const check = cache.get(t.id) || {
      id: t.id, status: "UNKNOWN", httpCode: null, latency: null,
      details: null, lastCheck: null, error: "PENDING_FIRST_CHECK",
    };

    const ut = uptimeChecks.get(t.id);
    const uptime = ut && ut.total > 0 ? ((ut.up / ut.total) * 100).toFixed(2) : null;

    // SSL cert info
    let certInfo = null;
    try {
      const hostname = new URL(t.url).hostname;
      certInfo = certCache.get(hostname) || null;
    } catch { /* ignore */ }

    return {
      ...check,
      name: t.name, group: t.group, url: t.url, type: t.type, icon: t.icon,
      latencyHistory: latencyHistory.get(t.id) || [],
      uptime,
      uptimeSince: ut?.since || null,
      certInfo,
    };
  });

  const summary = {
    total: targets.length,
    operational: targets.filter((t) => t.status === "OPERATIONAL").length,
    degraded: targets.filter((t) => t.status === "DEGRADED").length,
    down: targets.filter((t) => t.status === "DOWN").length,
    unknown: targets.filter((t) => t.status === "UNKNOWN").length,
  };

  res.json({ timestamp: new Date().toISOString(), pollInterval: POLL_INTERVAL, summary, targets });
});

app.post("/api/status/refresh", async (_req, res) => {
  await pollAll();
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get("/api/incidents", (_req, res) => {
  res.json({ incidents });
});

app.get("/api/certs", (_req, res) => {
  res.json({ certs: [...certCache.values()] });
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║         S I T R E P   O N L I N E           ║
  ║     Tactical Ops Dashboard v2.0.0           ║
  ║     http://localhost:${PORT}                   ║
  ╚══════════════════════════════════════════════╝
  `);
  console.log(`[SITREP] Monitoring ${TARGETS.length} targets every ${POLL_INTERVAL / 1000}s`);
  if (DISCORD_WEBHOOK) console.log("[SITREP] Discord webhook: ACTIVE");

  pollAll();
  setInterval(pollAll, POLL_INTERVAL);

  // SSL cert check on startup + every 6h
  pollCerts();
  setInterval(pollCerts, CERT_CHECK_INTERVAL);
});
