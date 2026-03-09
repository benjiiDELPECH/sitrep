// ============================================================================
// SITREP — Tactical Ops Dashboard v2.0
// ============================================================================
// Real-time health monitoring for all production assets.
// Features: health polling, uptime tracking, latency history, SSL cert expiry,
//           incident log persistence, Discord webhook alerts.
// ============================================================================

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const pinoHttp = require("pino-http");
const path = require("path");
const tls = require("tls");
const net = require("net");
const dns = require("dns");
const { promisify } = require("util");
const { TARGETS, APPS } = require("./config");
const log = require("./lib/logger");
const { loadIncidents, saveIncidents } = require("./lib/persistence");

const dnsResolve4 = promisify(dns.resolve4);

// ── Mode flags ──────────────────────────────────────────────────────────────
const IS_DEV = process.env.NODE_ENV !== "production";
const MOCK_MODE = process.env.MOCK_MODE === "true" || process.env.MOCK_MODE === "1";
let firstPollDone = false; // for /readyz

if (MOCK_MODE) {
  log.warn("MOCK_MODE enabled — simulated health responses, no production polling");
}

// Lazy-load mock provider only when needed
const mock = MOCK_MODE ? require("./lib/mock") : null;

const app = express();
app.set("trust proxy", 1); // Behind Traefik — required for rate limiting
const PORT = process.env.PORT || 3333;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || null;
const CERT_EXPIRY_ALERT_DAYS = Number(process.env.CERT_EXPIRY_ALERT_DAYS) || 14;

// ── Security hardening ──────────────────────────────────────────────────────
// In dev: relax headers that break HTTP localhost (HSTS, upgrade-insecure, CORP)
// In prod: full lockdown behind Traefik HTTPS
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "https://api.real-estate-analytics.com"],
      ...(IS_DEV ? { frameAncestors: ["*"], upgradeInsecureRequests: null } : {}),
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: IS_DEV ? false : { policy: "same-origin" },
  frameguard: IS_DEV ? false : undefined,
  // HSTS on plain HTTP poisons Safari's cache → all sub-resources upgraded to HTTPS → fail
  hsts: IS_DEV ? false : { maxAge: 31536000, includeSubDomains: true },
}));

// ── Rate limiting ───────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60,                  // 60 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

const refreshLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 5,                   // 5 manual refreshes per minute max
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Refresh rate limited. Please wait." },
});

// ── Health & readiness probes (not rate-limited) ────────────────────────────
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

app.get("/readyz", (_req, res) => {
  if (!firstPollDone) {
    return res.status(503).json({ status: "not_ready", reason: "first poll not completed" });
  }
  res.json({ status: "ready", targets: cache.size, uptime: process.uptime() });
});

// ── Prometheus metrics (text/plain) ─────────────────────────────────────────
app.get("/metrics", (_req, res) => {
  const lines = [];
  lines.push("# HELP sitrep_target_status Target status (1=operational, 0.5=degraded, 0=down)");
  lines.push("# TYPE sitrep_target_status gauge");
  lines.push("# HELP sitrep_target_latency_ms Target latency in milliseconds");
  lines.push("# TYPE sitrep_target_latency_ms gauge");
  lines.push("# HELP sitrep_target_uptime_ratio Target uptime ratio (0-1)");
  lines.push("# TYPE sitrep_target_uptime_ratio gauge");
  lines.push("# HELP sitrep_incidents_total Total incidents recorded");
  lines.push("# TYPE sitrep_incidents_total counter");

  for (const t of TARGETS) {
    const check = cache.get(t.id);
    const labels = `target="${t.id}",group="${t.group}"`;
    const statusVal = check?.status === "OPERATIONAL" ? 1 : check?.status === "DEGRADED" ? 0.5 : 0;
    lines.push(`sitrep_target_status{${labels}} ${statusVal}`);
    lines.push(`sitrep_target_latency_ms{${labels}} ${check?.latency || 0}`);
    const ut = uptimeChecks.get(t.id);
    const ratio = ut && ut.total > 0 ? (ut.up / ut.total).toFixed(4) : 0;
    lines.push(`sitrep_target_uptime_ratio{${labels}} ${ratio}`);
  }
  lines.push(`sitrep_incidents_total ${incidents.length}`);
  lines.push(`sitrep_poll_interval_seconds ${POLL_INTERVAL / 1000}`);
  lines.push(`sitrep_mock_mode ${MOCK_MODE ? 1 : 0}`);

  res.set("Content-Type", "text/plain; version=0.0.4");
  res.send(lines.join("\n") + "\n");
});

app.use("/api/", apiLimiter);
app.use("/api/status/refresh", refreshLimiter);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ── Request logging ─────────────────────────────────────────────────────────
app.use(pinoHttp({
  logger: log,
  autoLogging: {
    ignore: (req) => {
      // Don't log static files and health probes
      return req.url.startsWith("/style") || req.url.startsWith("/app")
        || req.url === "/healthz" || req.url === "/readyz"
        || req.url.endsWith(".css") || req.url.endsWith(".js")
        || req.url.endsWith(".json") || req.url.endsWith(".html");
    },
  },
  customLogLevel: (_req, res) => res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
}));

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

// ── Incident log (persistent, file-backed) ─────────────────────────────────
const incidents = loadIncidents();
const MAX_INCIDENTS = 200;
let _incidentSaveTimer = null;

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

  log.warn({ target: target.id, from, to, group: target.group }, `Status transition: ${from} → ${to}`);

  // Debounced save to disk (avoid thrashing on burst of transitions)
  if (_incidentSaveTimer) clearTimeout(_incidentSaveTimer);
  _incidentSaveTimer = setTimeout(() => saveIncidents(incidents), 2000);

  // Discord webhook
  if (DISCORD_WEBHOOK) {
    sendDiscordAlert(entry).catch((err) => {
      log.error({ err: err.message, target: target.id }, "Discord webhook failed");
    });
  }
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
    const info = MOCK_MODE ? mock.mockCheckCert(h) : await checkCert(h);
    if (info) certCache.set(h, info);
  }
  log.info({ count: certCache.size }, "SSL certs checked");

  // ── Cert expiry alerts ──
  if (DISCORD_WEBHOOK) {
    for (const [hostname, info] of certCache.entries()) {
      if (info.daysLeft <= CERT_EXPIRY_ALERT_DAYS) {
        // Only alert once per threshold bracket (avoids spam every 6h)
        const bracket = info.daysLeft <= 1 ? 1 : info.daysLeft <= 3 ? 3 : info.daysLeft <= 7 ? 7 : 14;
        const lastBracket = certAlertSent.get(hostname);
        if (lastBracket === bracket) continue;
        certAlertSent.set(hostname, bracket);

        log.warn({ hostname, daysLeft: info.daysLeft, validTo: info.validTo }, "SSL cert expiring soon");

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
        }).catch((err) => {
          log.error({ err: err.message, hostname }, "Discord cert alert webhook failed");
        });
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
  const checkFn = MOCK_MODE ? (t) => Promise.resolve(mock.mockCheckTarget(t)) : checkTarget;
  const results = await Promise.allSettled(TARGETS.map(checkFn));

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
  firstPollDone = true;
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


// ── API: Infra Graph (Cytoscape.js) ───────────────────────────────────────
app.get("/api/infra-graph", (_req, res) => {
  // 1. Nodes: map all targets as nodes
  const nodes = TARGETS.map((t) => {
    const check = cache.get(t.id) || { status: "UNKNOWN", error: "PENDING_FIRST_CHECK" };
    // Incidents for this node (last 3)
    const nodeIncidents = incidents.filter(i => i.id === t.id).slice(0, 3);
    return {
      data: {
        id: t.id,
        label: t.name,
        type: t.type || "service",
        status: check.status,
        group: t.group || null,
        diagnostic: check.error || check.diagnosis?.code || "OK",
        incidents: nodeIncidents,
        url: t.url,
        latency: check.latency || null,
        uptime: (uptimeChecks.get(t.id)?.up || 0) + "/" + (uptimeChecks.get(t.id)?.total || 0),
      }
    };
  });

  // 2. Edges: simple heuristics (Traefik → services, Worker → containers, etc)
  // For demo: statically define some edges (could be improved with config)
  const edges = [];
  // Example: Traefik routes
  const traefik = TARGETS.find(t => t.id === "traefik");
  if (traefik) {
    for (const t of TARGETS) {
      if (t.id !== "traefik" && t.group && ["k8s", "docker"].includes(t.type)) {
        edges.push({ data: { source: "traefik", target: t.id, type: "network", critical: true } });
      }
    }
  }
  // Example: Worker-1 → containers
  const worker = TARGETS.find(t => t.id === "worker1");
  if (worker) {
    for (const t of TARGETS) {
      if (t.id !== "worker1" && t.group && t.group === worker.group && t.type !== "server") {
        edges.push({ data: { source: "worker1", target: t.id, type: "hosted-on" } });
      }
    }
  }
  // Example: Gitea → PostgreSQL
  if (TARGETS.find(t => t.id === "gitea") && TARGETS.find(t => t.id === "pg-gitea")) {
    edges.push({ data: { source: "gitea", target: "pg-gitea", type: "db", critical: true } });
  }
  // Example: Next.js → Spring Boot
  if (TARGETS.find(t => t.id === "nextjs") && TARGETS.find(t => t.id === "spring")) {
    edges.push({ data: { source: "nextjs", target: "spring", type: "api" } });
  }

  // TODO: enrich with more edges as needed

  res.json({
    timestamp: new Date().toISOString(),
    nodes,
    edges
  });
});

// ── API: Multi-App Registry ─────────────────────────────────────────────────
// Returns the list of registered apps (sans backendUrl for security)
const appsIndex = new Map(APPS.map((a) => [a.id, a]));

app.get("/api/apps", (_req, res) => {
  const apps = APPS.map(({ backendUrl, ...rest }) => rest);
  res.json({ apps, timestamp: new Date().toISOString() });
});

// ── API: Multi-App Dashboard Proxy ──────────────────────────────────────────
// Generic proxy: /api/apps/:appId/dashboard/:endpoint
// Routes to the app's backendUrl + /api/admin/dashboard/:endpoint
const dashboardCache = new Map(); // "appId:endpoint" → { data, ts }
const DASHBOARD_CACHE_TTL = 10_000; // 10s

app.get("/api/apps/:appId/dashboard/:endpoint", async (req, res) => {
  const { appId, endpoint } = req.params;
  const appConfig = appsIndex.get(appId);

  if (!appConfig) {
    return res.status(404).json({ error: `Unknown app: ${appId}` });
  }
  if (!appConfig.dashboard) {
    return res.status(404).json({ error: `App ${appId} has no business dashboard configured` });
  }
  if (!appConfig.dashboard.endpoints.includes(endpoint)) {
    return res.status(404).json({ error: `Endpoint '${endpoint}' not available for ${appId}` });
  }

  const cacheKey = `${appId}:${endpoint}`;
  const now = Date.now();

  const cached = dashboardCache.get(cacheKey);
  if (cached && now - cached.ts < DASHBOARD_CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    const backendRes = await fetch(
      `${appConfig.backendUrl}/api/admin/dashboard/${endpoint}`,
      {
        headers: { "User-Agent": "SITREP/2.0" },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!backendRes.ok) throw new Error(`HTTP ${backendRes.status}`);

    const data = await backendRes.json();
    dashboardCache.set(cacheKey, { data, ts: now });
    res.json(data);
  } catch (err) {
    log.error({ err: err.message, app: appId, endpoint }, "Dashboard proxy failed");
    if (cached) return res.json({ ...cached.data, stale: true });
    res.status(502).json({
      error: `${appConfig.name} backend unreachable: ${endpoint}`,
      message: err.message,
    });
  }
});

// ── API: Multi-App ADEME Proxy ──────────────────────────────────────────────
// Only for apps with dashboard.ademe = true
const ademeCache = new Map(); // appId → { data, ts }
const ADEME_CACHE_TTL = 15_000; // 15s

app.get("/api/apps/:appId/ademe", async (req, res) => {
  const { appId } = req.params;
  const appConfig = appsIndex.get(appId);

  if (!appConfig) return res.status(404).json({ error: `Unknown app: ${appId}` });
  if (!appConfig.dashboard?.ademe) {
    return res.status(404).json({ error: `App ${appId} has no ADEME integration` });
  }

  const now = Date.now();
  const cached = ademeCache.get(appId);
  if (cached && now - cached.ts < ADEME_CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    const [statsRes, healthRes] = await Promise.all([
      fetch(`${appConfig.backendUrl}/api/admin/ademe/stats`, {
        headers: { "User-Agent": "SITREP/2.0" },
        signal: AbortSignal.timeout(8000),
      }),
      fetch(`${appConfig.backendUrl}/api/admin/ademe/health`, {
        headers: { "User-Agent": "SITREP/2.0" },
        signal: AbortSignal.timeout(5000),
      }),
    ]);

    if (!statsRes.ok) throw new Error(`Stats: HTTP ${statsRes.status}`);
    if (!healthRes.ok) throw new Error(`Health: HTTP ${healthRes.status}`);

    const stats = await statsRes.json();
    const health = await healthRes.json();

    const payload = { ...stats, health, fetchedAt: new Date().toISOString() };
    ademeCache.set(appId, { data: payload, ts: now });
    res.json(payload);
  } catch (err) {
    log.error({ err: err.message, app: appId }, "ADEME proxy failed");
    if (cached) return res.json({ ...cached.data, stale: true });
    res.status(502).json({
      error: `${appConfig.name} ADEME backend unreachable`,
      message: err.message,
    });
  }
});

// ── API: App Health Summary (from SITREP monitoring data) ───────────────────
// Returns health status for a given app's targets group
app.get("/api/apps/:appId/health", (req, res) => {
  const { appId } = req.params;
  const appConfig = appsIndex.get(appId);
  if (!appConfig) return res.status(404).json({ error: `Unknown app: ${appId}` });

  // Find targets matching this app's group
  const groupTargets = TARGETS.filter((t) => t.group === appConfig.group);
  const healthData = groupTargets.map((t) => {
    const cached = cache.get(t.id);
    const history = latencyHistory.get(t.id) || [];
    const uptime = uptimeChecks.get(t.id);
    return {
      id: t.id,
      name: t.name,
      icon: t.icon,
      status: cached?.status || "UNKNOWN",
      latency: cached?.latency || null,
      httpCode: cached?.httpCode || null,
      lastCheck: cached?.lastCheck || null,
      latencyHistory: history,
      uptime: uptime ? ((uptime.up / uptime.total) * 100).toFixed(2) : null,
    };
  });

  res.json({
    app: { id: appConfig.id, name: appConfig.name, icon: appConfig.icon },
    targets: healthData,
    timestamp: new Date().toISOString(),
  });
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

    log.info({ count: dbMetrics.size }, "Database metrics updated");
  } catch (err) {
    log.error({ err: err.message }, "Failed to fetch database metrics");
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

// ── Global error handlers (no more silent crashes) ─────────────────────────
process.on("unhandledRejection", (reason, promise) => {
  log.error({ err: reason?.message || reason, stack: reason?.stack }, "Unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  log.fatal({ err: err.message, stack: err.stack }, "Uncaught exception — shutting down");
  process.exit(1);
});

// ── Start ───────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  log.info({
    port: PORT,
    targets: TARGETS.length,
    pollInterval: `${POLL_INTERVAL / 1000}s`,
    mockMode: MOCK_MODE,
    dev: IS_DEV,
    discord: !!DISCORD_WEBHOOK,
  }, `SITREP v2.1 online — http://localhost:${PORT}`);

  pollAll();
  setInterval(pollAll, POLL_INTERVAL);

  // SSL cert check on startup + every 6h
  pollCerts();
  setInterval(pollCerts, CERT_CHECK_INTERVAL);
});

// ── Graceful shutdown (K8s SIGTERM) ─────────────────────────────────────────
function gracefulShutdown(signal) {
  log.info({ signal }, "Shutting down gracefully...");
  // Persist incidents before exit
  saveIncidents(incidents);
  server.close(() => {
    log.info("HTTP server closed. Goodbye.");
    process.exit(0);
  });
  // Force exit after 10s if connections don't drain
  setTimeout(() => {
    log.error("Forced exit after timeout");
    process.exit(1);
  }, 10_000);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
