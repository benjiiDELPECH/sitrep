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
const net = require("net");
const dns = require("dns");
const { promisify } = require("util");
const { TARGETS } = require("./config");

const dnsResolve4 = promisify(dns.resolve4);

const app = express();
const PORT = process.env.PORT || 3333;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || null;
const CERT_EXPIRY_ALERT_DAYS = Number(process.env.CERT_EXPIRY_ALERT_DAYS) || 14;

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

// ── Database Isolation Policy Metrics ───────────────────────────────────────
// Intégration avec data-isolation-policy.md Decision Matrix
const dbMetrics = new Map(); // app_id → { charge_pct, pool_pct, size_gb, incidents_90d, last_backup }
const DB_METRICS_REFRESH = 5 * 60 * 1000; // 5min

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
const certAlertSent = new Map(); // hostname → daysLeft threshold last alerted
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

  // ── Cert expiry alerts ──
  if (DISCORD_WEBHOOK) {
    for (const [hostname, info] of certCache.entries()) {
      if (info.daysLeft <= CERT_EXPIRY_ALERT_DAYS) {
        // Only alert once per threshold bracket (avoids spam every 6h)
        const bracket = info.daysLeft <= 1 ? 1 : info.daysLeft <= 3 ? 3 : info.daysLeft <= 7 ? 7 : 14;
        const lastBracket = certAlertSent.get(hostname);
        if (lastBracket === bracket) continue;
        certAlertSent.set(hostname, bracket);

        const color = info.daysLeft <= 1 ? 0xff0000 : info.daysLeft <= 3 ? 0xff3333 : info.daysLeft <= 7 ? 0xffaa00 : 0xffcc00;
        const emoji = info.daysLeft <= 3 ? "🚨" : "⚠️";

        fetch(DISCORD_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: info.daysLeft <= 3 ? "@here" : undefined,
            embeds: [{
              title: `${emoji} SSL Certificate Expiring — ${hostname}`,
              description: `Certificate expires in **${info.daysLeft} day${info.daysLeft !== 1 ? "s" : ""}**`,
              color,
              fields: [
                { name: "Hostname", value: hostname, inline: true },
                { name: "Expires", value: info.validTo.split("T")[0], inline: true },
                { name: "Issuer", value: info.issuer, inline: true },
              ],
              footer: { text: "SITREP — Cert Expiry Monitor" },
              timestamp: new Date().toISOString(),
            }],
          }),
        }).catch(() => {});
      }
    }
  }
}

// ── Multi-layer diagnostic (DNS → TCP → TLS → HTTP) ────────────────────────
async function diagnoseFailure(url) {
  const parsed = new URL(url);
  const hostname = parsed.hostname;
  const port = parsed.port || (parsed.protocol === "https:" ? 443 : 80);
  const layers = { dns: null, tcp: null, tls: null };

  // Layer 1: DNS
  try {
    const addresses = await dnsResolve4(hostname);
    layers.dns = { ok: true, addresses };
  } catch (err) {
    layers.dns = { ok: false, error: err.code || err.message };
    return { failedAt: "DNS", code: `DNS_${err.code || "FAIL"}`, layers,
             message: `DNS resolution failed: ${err.code || err.message} — check your DNS records for ${hostname}` };
  }

  // Layer 2: TCP
  try {
    await new Promise((resolve, reject) => {
      const sock = net.connect({ host: hostname, port, timeout: 5000 }, () => { sock.end(); resolve(); });
      sock.on("error", reject);
      sock.on("timeout", () => { sock.destroy(); reject(new Error("TCP_TIMEOUT")); });
    });
    layers.tcp = { ok: true, port };
  } catch (err) {
    layers.tcp = { ok: false, error: err.message };
    return { failedAt: "TCP", code: `TCP_${err.code || "FAIL"}`, layers,
             message: `TCP connection to ${hostname}:${port} failed — server may be down or port blocked` };
  }

  // Layer 3: TLS (only for HTTPS)
  if (parsed.protocol === "https:") {
    try {
      await new Promise((resolve, reject) => {
        const socket = tls.connect({ host: hostname, port, servername: hostname, timeout: 5000 }, () => {
          const cert = socket.getPeerCertificate();
          if (cert && cert.valid_to) {
            const daysLeft = Math.floor((new Date(cert.valid_to) - Date.now()) / 86400000);
            layers.tls = { ok: true, daysLeft, validTo: cert.valid_to, issuer: cert.issuer?.O || "Unknown" };
          } else {
            layers.tls = { ok: true };
          }
          socket.end();
          resolve();
        });
        socket.on("error", reject);
        socket.on("timeout", () => { socket.destroy(); reject(new Error("TLS_TIMEOUT")); });
      });
    } catch (err) {
      layers.tls = { ok: false, error: err.message };
      return { failedAt: "TLS", code: "TLS_CERT_INVALID", layers,
               message: `TLS handshake failed on ${hostname} — ${err.message}. Check cert-manager / Let's Encrypt.` };
    }
  }

  return { failedAt: null, code: null, layers, message: null };
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

    let details = null;
    let components = null;
    try {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("json")) {
        details = await res.json();
        if (target.type === "composite" && details.components) {
          components = details.components;
        }
      }
    } catch { /* ignore */ }

    // Determine status
    let status;
    let error = null;
    let diagnosis = null;

    if (target.type === "composite") {
      if (!res.ok) {
        status = "DOWN";
        error = res.status === 401 ? "ENDPOINT_NOT_DEPLOYED (401 — redeploy gateway with SystemHealthController)"
              : res.status === 404 ? "ENDPOINT_NOT_FOUND (404)"
              : `HTTP_${res.status}`;
      } else if (details?.status) {
        status = details.status === "UP" ? "OPERATIONAL"
               : details.status === "DEGRADED" ? "DEGRADED"
               : "DOWN";
      } else {
        status = "DEGRADED";
        error = "INVALID_RESPONSE — no status field in JSON";
      }
    } else {
      status = res.ok ? "OPERATIONAL" : "DEGRADED";
      if (!res.ok) {
        error = `HTTP_${res.status}`;
      }
    }

    return {
      id: target.id, status, httpCode: res.status, latency, details, components,
      lastCheck: new Date().toISOString(), error, diagnosis,
    };
  } catch (err) {
    clearTimeout(timeout);
    const latency = Date.now() - start;

    // ── Multi-layer diagnosis on failure ──
    let diagnosis = null;
    let errorCode = err.name === "AbortError" ? "TIMEOUT" : err.message;
    try {
      diagnosis = await diagnoseFailure(target.url);
      if (diagnosis.failedAt) {
        errorCode = diagnosis.code;
      }
    } catch { /* diagnosis itself failed, keep original error */ }

    return {
      id: target.id, status: "DOWN", httpCode: null,
      latency, details: null, components: null,
      lastCheck: new Date().toISOString(),
      error: errorCode,
      diagnosis,
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
      components: check.components || null,
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

// ── Database Isolation Policy Metrics ───────────────────────────────────────
app.get("/api/database-metrics", (_req, res) => {
  const metrics = [...dbMetrics.entries()].map(([app_id, data]) => ({
    app_id,
    ...data,
    decision_matrix: evaluateDecisionMatrix(data),
  }));
  res.json({ metrics, timestamp: new Date().toISOString() });
});

// ── Database Metrics Polling (Prometheus) ───────────────────────────────────
async function pollDatabaseMetrics() {
  const prometheusUrl = process.env.PROMETHEUS_URL;
  if (!prometheusUrl) return;
  
  try {
    // Query Alert-Immo metrics
    const [charge, pool, size, incidents, backup] = await Promise.all([
      queryPrometheus(prometheusUrl, 'alertimmo:database:charge_pct:7d'),
      queryPrometheus(prometheusUrl, 'alertimmo:database:pool_saturation_pct:7d'),
      queryPrometheus(prometheusUrl, 'alertimmo:database:size_gb'),
      queryPrometheus(prometheusUrl, 'count_over_time(ALERTS{severity=~"P1|P2",app="alert-immo",component="postgres"}[90d])'),
      queryPrometheus(prometheusUrl, 'time() - kube_job_status_completion_time{job_name=~"postgres-backup.*",namespace="alert-immo"}'),
    ]);
    
    dbMetrics.set('alert-immo', {
      charge_pct: parseFloat(charge?.value?.[1]) || 0,
      pool_pct: parseFloat(pool?.value?.[1]) || 0,
      size_gb: parseFloat(size?.value?.[1]) || 0,
      incidents_90d: parseInt(incidents?.value?.[1]) || 0,
      last_backup_hours_ago: (parseFloat(backup?.value?.[1]) || 0) / 3600,
      updated_at: new Date().toISOString(),
    });
    
    console.log(`[SITREP] Database metrics updated: ${dbMetrics.size} apps`);
  } catch (err) {
    console.error(`[SITREP] Failed to fetch database metrics: ${err.message}`);
  }
}

async function queryPrometheus(baseUrl, query) {
  const url = `${baseUrl}/api/v1/query?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { timeout: 5000 });
  if (!res.ok) throw new Error(`Prometheus query failed: ${res.status}`);
  const data = await res.json();
  return data?.data?.result?.[0] || null;
}

function evaluateDecisionMatrix(data) {
  const critical = {
    incidents_p1_p2: data.incidents_90d >= 2,
  };
  const important = {
    charge_high: data.charge_pct > 35,
    pool_saturation: data.pool_pct > 60,
    size_large: data.size_gb > 50,
  };
  
  const critical_count = Object.values(critical).filter(Boolean).length;
  const important_count = Object.values(important).filter(Boolean).length;
  
  return {
    critical,
    important,
    critical_count,
    important_count,
    should_migrate: critical_count >= 1 || important_count >= 2,
    recommendation: critical_count >= 1 || important_count >= 2 
      ? 'MIGRATE_DEDICATED' 
      : 'STAY_SHARED',
  };
}

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
