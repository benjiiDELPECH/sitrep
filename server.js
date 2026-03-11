// ============================================================================
// SITREP — Tactical Ops Dashboard v2.2
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
const monitoringHub = require("./lib/monitoring-hub");
const geoip = require("geoip-lite");

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

// ── Inbound request tracing ─────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  // Skip SSE stream and static assets from tracing
  if (req.url === "/api/events/stream" || req.url === "/healthz" || req.url === "/readyz") return next();
  const isStatic = /\.(css|js|json|html|ico|png|svg|woff2?)$/.test(req.url);

  res.on("finish", () => {
    const latency = Date.now() - start;
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
            || req.headers["x-real-ip"]
            || req.socket.remoteAddress || "unknown";
    const ua = req.headers["user-agent"] || "unknown";
    const uaShort = ua.length > 60 ? ua.substring(0, 57) + "…" : ua;

    // Always count in traffic stats
    trafficStats.inbound.total++;
    trafficStats.inbound.perPath[req.url] = (trafficStats.inbound.perPath[req.url] || 0) + 1;
    trafficStats.inbound.perIP[ip] = (trafficStats.inbound.perIP[ip] || 0) + 1;
    trafficStats.inbound.perUA[uaShort] = (trafficStats.inbound.perUA[uaShort] || 0) + 1;

    // ── IP Intelligence enrichment ──
    const ipRec = getIPRecord(ip);
    ipRec.hits++;
    ipRec.lastSeen = new Date().toISOString();
    ipRec.paths[req.url] = (ipRec.paths[req.url] || 0) + 1;
    ipRec.methods[req.method] = (ipRec.methods[req.method] || 0) + 1;
    ipRec.statuses[res.statusCode] = (ipRec.statuses[res.statusCode] || 0) + 1;
    if (!ipRec.userAgents.includes(uaShort) && ipRec.userAgents.length < 5) ipRec.userAgents.push(uaShort);
    const threat = scoreThreat(ipRec, req);

    // Country stats
    if (ipRec.country) {
      if (!countryStats[ipRec.country]) countryStats[ipRec.country] = { hits: 0, ips: new Set(), lastSeen: null, flag: ipRec.countryFlag };
      countryStats[ipRec.country].hits++;
      countryStats[ipRec.country].lastSeen = ipRec.lastSeen;
    }

    // Emit event only for API calls (not static files — too noisy)
    if (!isStatic) {
      const sev = threat.score >= 4 ? "critical" : res.statusCode >= 500 ? "critical" : res.statusCode >= 400 ? "warn" : "info";
      emitEvent("REQUEST_IN", sev, null,
        `← ${req.method} ${req.url} ${res.statusCode} ${latency}ms [${ipRec.countryFlag} ${ip}${ipRec.city ? ' ' + ipRec.city : ''}]`,
        {
          method: req.method, path: req.url, status: res.statusCode, latency, ip, ua: uaShort, isStatic,
          // Geo enrichment
          country: ipRec.country, countryFlag: ipRec.countryFlag, city: ipRec.city,
          region: ipRec.region, timezone: ipRec.timezone, ll: ipRec.ll,
          // Threat
          threatScore: ipRec.threatScore, threatReasons: ipRec.threatReasons,
          hits: ipRec.hits, honeypotHits: ipRec.honeypotHits,
        });
    }
  });
  next();
});

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

// ── Real-time Event Bus (SSE) ───────────────────────────────────────────────
const eventBuffer = [];        // circular buffer — last N events
const EVENT_BUFFER_SIZE = 300;
const sseClients = new Set();  // active SSE connections
let eventSeq = 0;              // monotonic event sequence

// ── Traffic Intelligence ────────────────────────────────────────────────────
const trafficStats = {
  inbound: { total: 0, perPath: {}, perIP: {}, perUA: {}, history: [] },   // rolling 1min windows
  outbound: { total: 0, perTarget: {}, history: [] },
  startedAt: new Date().toISOString(),
};
const TRAFFIC_WINDOW = 60_000; // 1 minute windows
let _trafficWindowTimer = null;

// ── IP Intelligence Registry (Honeypot) ─────────────────────────────────────
// Every IP that touches the cluster is tracked permanently (in-memory, reset on restart).
// Enriched with GeoIP (country, city, coords), threat scoring, behavioral analysis.
const ipRegistry = new Map(); // ip → IPRecord
const countryStats = {};       // country_code → { hits, ips: Set, lastSeen }
const THREAT_DECAY_MS = 30 * 60 * 1000; // threat score decays after 30min inactivity

// Country code → flag emoji
function countryFlag(cc) {
  if (!cc || cc.length !== 2) return '🌐';
  return String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1E6 - 65 + c.charCodeAt(0)));
}

// Known bad User-Agent patterns (scanners, bots, exploit tools)
const THREAT_UA_PATTERNS = [
  /nmap/i, /nikto/i, /sqlmap/i, /dirbust/i, /gobust/i, /wfuzz/i,
  /hydra/i, /masscan/i, /zgrab/i, /censys/i, /shodan/i,
  /nuclei/i, /jaeles/i, /burp/i, /owasp/i, /metasploit/i,
  /python-requests/i, /go-http-client/i, /curl\//i,
  /bot.*scan/i, /scan.*bot/i, /crawl/i, /spider/i,
  /wget/i, /libwww/i, /lwp-trivial/i,
];

// Suspicious path patterns (honeypot triggers)
const HONEYPOT_PATHS = [
  /\.env/i, /wp-admin/i, /wp-login/i, /wordpress/i, /phpmyadmin/i,
  /\.git\//i, /\.svn/i, /\.DS_Store/i, /xmlrpc\.php/i,
  /actuator(?!\/health)/i, /admin\/config/i, /\.aws/i,
  /shell|cmd|exec|eval/i, /etc\/passwd/i, /\.well-known\/security/i,
  /backup|dump|database/i, /config\.json|secrets/i,
  /\.(sql|bak|old|swp|zip|tar|gz)$/i,
];

function getIPRecord(ip) {
  if (ipRegistry.has(ip)) return ipRegistry.get(ip);
  // GeoIP lookup
  const geo = geoip.lookup(ip) || null;
  const record = {
    ip,
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    hits: 0,
    paths: {},         // path → count
    methods: {},       // method → count
    statuses: {},      // status_code → count
    userAgents: [],    // unique UAs seen (max 5)
    // GeoIP
    country: geo?.country || null,
    countryFlag: countryFlag(geo?.country),
    city: geo?.city || null,
    region: geo?.region || null,
    timezone: geo?.timezone || null,
    ll: geo?.ll || null,
    eu: geo?.eu === '1',
    // Threat
    threatScore: 0,    // 0=clean, 1-3=suspicious, 4+=hostile
    threatReasons: [], // why the score is high
    isScanner: false,
    isBotUA: false,
    honeypotHits: 0,   // how many honeypot paths triggered
    rateBurst: 0,      // requests in last 60s
    rateHistory: [],   // timestamps of recent requests (last 60 entries)
    blocked: false,
  };
  ipRegistry.set(ip, record);

  // Track country stats
  if (record.country) {
    if (!countryStats[record.country]) {
      countryStats[record.country] = { hits: 0, ips: new Set(), lastSeen: null, flag: record.countryFlag };
    }
    countryStats[record.country].ips.add(ip);
  }
  return record;
}

function scoreThreat(record, req) {
  const reasons = [];
  let score = 0;
  const ua = req.headers['user-agent'] || '';
  const path = req.url;

  // 1. Bad UA detection
  if (THREAT_UA_PATTERNS.some(p => p.test(ua))) {
    score += 3;
    reasons.push('SCANNER_UA');
    record.isScanner = true;
  }
  if (!ua || ua === 'unknown' || ua.length < 10) {
    score += 1;
    reasons.push('EMPTY_UA');
  }

  // 2. Honeypot path
  if (HONEYPOT_PATHS.some(p => p.test(path))) {
    score += 4;
    reasons.push('HONEYPOT_PATH');
    record.honeypotHits++;
  }

  // 3. Rate burst (>30 req in 60s)
  const now = Date.now();
  record.rateHistory.push(now);
  record.rateHistory = record.rateHistory.filter(t => now - t < 60000);
  record.rateBurst = record.rateHistory.length;
  if (record.rateBurst > 30) {
    score += 2;
    reasons.push('RATE_BURST');
  } else if (record.rateBurst > 60) {
    score += 4;
    reasons.push('RATE_FLOOD');
  }

  // 4. 4xx accumulation (probing)
  const total4xx = Object.entries(record.statuses)
    .filter(([code]) => code >= 400 && code < 500)
    .reduce((sum, [, count]) => sum + count, 0);
  if (total4xx > 10) {
    score += 2;
    reasons.push('PROBE_4XX');
  }

  // 5. Path diversity (scanning many different paths)
  if (Object.keys(record.paths).length > 15) {
    score += 2;
    reasons.push('PATH_SCAN');
  }

  // Apply score (max of current + new, with some decay)
  record.threatScore = Math.max(record.threatScore, score);
  for (const r of reasons) {
    if (!record.threatReasons.includes(r)) record.threatReasons.push(r);
  }

  return { score, reasons };
}

// Periodic threat alert to Discord (check every 60s)
let _threatAlertTimer = null;
const _alertedIPs = new Set(); // already alerted this session

function checkThreatAlerts() {
  if (!DISCORD_WEBHOOK) return;
  for (const [ip, record] of ipRegistry) {
    if (record.threatScore >= 4 && !_alertedIPs.has(ip)) {
      _alertedIPs.add(ip);
      const flag = record.countryFlag || '🌐';
      const city = record.city || '?';
      const country = record.country || '??';
      log.warn({ ip, threat: record.threatScore, reasons: record.threatReasons, country, city },
        `THREAT DETECTED: ${ip} (${flag} ${country}/${city}) — score ${record.threatScore}`);

      emitEvent('THREAT', 'critical', null,
        `🚨 THREAT ${flag} ${ip} (${country}/${city}) — score ${record.threatScore} [${record.threatReasons.join(',')}]`,
        { ip, country, city, flag: record.countryFlag, score: record.threatScore, reasons: record.threatReasons, hits: record.hits });

      // Discord
      fetch(DISCORD_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: record.threatScore >= 6 ? '@here' : undefined,
          embeds: [{
            title: `🚨 Threat Detected — ${flag} ${ip}`,
            color: record.threatScore >= 6 ? 0xff0000 : 0xff6600,
            fields: [
              { name: 'Location', value: `${flag} ${country} / ${city}`, inline: true },
              { name: 'Threat Score', value: `${record.threatScore}/10`, inline: true },
              { name: 'Hits', value: `${record.hits}`, inline: true },
              { name: 'Reasons', value: record.threatReasons.join(', ') },
              { name: 'User-Agents', value: record.userAgents.slice(0, 3).join('\n') || 'none' },
              { name: 'Top Paths', value: Object.entries(record.paths).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, c]) => `${p} (${c}×)`).join('\n') || 'none' },
            ],
            footer: { text: 'SITREP — Honeypot Intelligence' },
            timestamp: new Date().toISOString(),
          }],
        }),
      }).catch(err => log.error({ err: err.message, ip }, 'Threat Discord alert failed'));
    }
  }
}
_threatAlertTimer = setInterval(checkThreatAlerts, 60_000);

function rotateTrafficWindow() {
  const now = new Date().toISOString();
  trafficStats.inbound.history.push({
    ts: now, count: trafficStats.inbound.total,
    topPaths: { ...trafficStats.inbound.perPath },
    topIPs: { ...trafficStats.inbound.perIP },
  });
  trafficStats.outbound.history.push({
    ts: now, count: trafficStats.outbound.total,
    perTarget: { ...trafficStats.outbound.perTarget },
  });
  // Keep last 30 windows (30 min)
  if (trafficStats.inbound.history.length > 30) trafficStats.inbound.history.shift();
  if (trafficStats.outbound.history.length > 30) trafficStats.outbound.history.shift();
  // Reset counters for next window
  trafficStats.inbound.total = 0;
  trafficStats.inbound.perPath = {};
  trafficStats.inbound.perIP = {};
  trafficStats.inbound.perUA = {};
  trafficStats.outbound.total = 0;
  trafficStats.outbound.perTarget = {};
}
_trafficWindowTimer = setInterval(rotateTrafficWindow, TRAFFIC_WINDOW);

function emitEvent(type, severity, target, message, data = {}) {
  const evt = {
    seq: ++eventSeq,
    ts: new Date().toISOString(),
    type,       // HEALTH_CHECK | STATUS_CHANGE | CERT_CHECK | INCIDENT | STARTUP | POLL_CYCLE | REQUEST_IN | REQUEST_OUT | THREAT
    severity,   // info | warn | critical | ok
    target,     // target id or null
    message,
    data,
  };
  eventBuffer.push(evt);
  if (eventBuffer.length > EVENT_BUFFER_SIZE) eventBuffer.shift();

  // Push to all SSE clients
  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

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

  // Emit to event bus
  const sev = to === "DOWN" ? "critical" : to === "DEGRADED" ? "warn" : "ok";
  emitEvent("STATUS_CHANGE", sev, target.id,
    `${target.icon || "●"} ${target.name}: ${from} → ${to}`,
    { from, to, group: target.group, icon: target.icon, name: target.name });

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
    if (info) {
      certCache.set(h, info);
      const sev = info.daysLeft <= 7 ? "critical" : info.daysLeft <= 30 ? "warn" : "info";
      emitEvent("CERT_CHECK", sev, h,
        `🔒 ${h} — ${info.daysLeft}d left (${info.issuer})`,
        { hostname: h, daysLeft: info.daysLeft, issuer: info.issuer, validTo: info.validTo });
    }
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

    // Emit outbound request event
    trafficStats.outbound.total++;
    trafficStats.outbound.perTarget[target.id] = (trafficStats.outbound.perTarget[target.id] || 0) + 1;
    emitEvent("REQUEST_OUT", status === "OPERATIONAL" ? "info" : status === "DEGRADED" ? "warn" : "critical",
      target.id,
      `→ GET ${target.url} ${res.status} ${latency}ms`,
      { method: "GET", url: target.url, status: res.status, latency, targetId: target.id, targetStatus: status });

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

    // Emit outbound request event (failure)
    trafficStats.outbound.total++;
    trafficStats.outbound.perTarget[target.id] = (trafficStats.outbound.perTarget[target.id] || 0) + 1;
    emitEvent("REQUEST_OUT", "critical", target.id,
      `→ GET ${target.url} FAIL ${latency}ms (${errorCode})`,
      { method: "GET", url: target.url, status: null, latency, targetId: target.id, targetStatus: "DOWN", error: errorCode });

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

  let up = 0, deg = 0, down = 0;

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

    // Emit individual HEALTH_CHECK event
    const target = TARGETS.find((t) => t.id === val.id);
    const sev = val.status === "DOWN" ? "critical" : val.status === "DEGRADED" ? "warn" : "info";
    emitEvent("HEALTH_CHECK", sev, val.id,
      `${target?.icon || "●"} ${target?.name || val.id} → ${val.status} (${val.latency || "?"}ms, HTTP ${val.httpCode || "—"})`,
      { status: val.status, latency: val.latency, httpCode: val.httpCode, error: val.error, group: target?.group });

    if (val.status === "OPERATIONAL") up++;
    else if (val.status === "DEGRADED") deg++;
    else down++;
  }
  firstPollDone = true;

  // Emit POLL_CYCLE summary
  const sev = down > 0 ? "critical" : deg > 0 ? "warn" : "ok";
  emitEvent("POLL_CYCLE", sev, null,
    `Poll complete — ${up} UP / ${deg} DEGRADED / ${down} DOWN (${TARGETS.length} targets)`,
    { up, degraded: deg, down, total: TARGETS.length });
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

// ── API: SSE Real-time Event Stream ─────────────────────────────────────────
app.get("/api/events/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",     // nginx passthrough
  });
  // Send initial buffer as catch-up
  for (const evt of eventBuffer.slice(-50)) {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }
  sseClients.add(res);
  log.info({ clients: sseClients.size }, "SSE client connected");

  // Heartbeat every 15s to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); sseClients.delete(res); }
  }, 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    log.info({ clients: sseClients.size }, "SSE client disconnected");
  });
});

// ── API: Recent events (REST fallback) ──────────────────────────────────────
app.get("/api/events/recent", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, EVENT_BUFFER_SIZE);
  const type = req.query.type || null;
  let events = type
    ? eventBuffer.filter((e) => e.type === type)
    : [...eventBuffer];
  res.json({ events: events.slice(-limit), total: eventBuffer.length, seq: eventSeq });
});


// ── API: Traffic Stats ──────────────────────────────────────────────────────
app.get("/api/traffic/stats", (_req, res) => {
  // Sort and cap top entries
  const topN = (obj, n = 10) => Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));

  res.json({
    inbound: {
      total: trafficStats.inbound.total,
      topPaths: topN(trafficStats.inbound.perPath),
      topIPs: topN(trafficStats.inbound.perIP),
      topUAs: topN(trafficStats.inbound.perUA, 5),
      history: trafficStats.inbound.history.slice(-15),
    },
    outbound: {
      total: trafficStats.outbound.total,
      perTarget: topN(trafficStats.outbound.perTarget),
      history: trafficStats.outbound.history.slice(-15),
    },
    since: trafficStats.startedAt,
    timestamp: new Date().toISOString(),
  });
});

// ── API: IP Intelligence (Honeypot) ─────────────────────────────────────────
app.get("/api/traffic/intel", (_req, res) => {
  // All tracked IPs, sorted by threat score desc, then hits desc
  const allIPs = [...ipRegistry.values()]
    .sort((a, b) => b.threatScore - a.threatScore || b.hits - a.hits);

  // Country breakdown
  const countries = Object.entries(countryStats)
    .map(([code, data]) => ({
      code, flag: data.flag, hits: data.hits,
      uniqueIPs: data.ips.size, lastSeen: data.lastSeen,
    }))
    .sort((a, b) => b.hits - a.hits);

  // Threats only (score >= 3)
  const threats = allIPs.filter(r => r.threatScore >= 3);

  // Summary
  const summary = {
    totalIPs: ipRegistry.size,
    totalHits: allIPs.reduce((s, r) => s + r.hits, 0),
    totalCountries: countries.length,
    totalThreats: threats.length,
    topCountry: countries[0] || null,
    highestThreat: threats[0] || null,
  };

  // Return top 50 IPs (full records without rateHistory for bandwidth)
  const topIPs = allIPs.slice(0, 50).map(r => {
    const { rateHistory, ...rest } = r;
    return { ...rest, rateBurst: r.rateBurst };
  });

  res.json({
    summary,
    ips: topIPs,
    countries: countries.slice(0, 30),
    threats: threats.slice(0, 20).map(r => {
      const { rateHistory, ...rest } = r;
      return rest;
    }),
    since: trafficStats.startedAt,
    timestamp: new Date().toISOString(),
  });
});

// ── API: Infra Graph (Cytoscape.js) ───────────────────────────────────────
// Real infrastructure topology with:
//   - Virtual infra nodes (Traefik, Hetzner, K3s, Vercel, Firebase, Let's Encrypt)
//   - Compound nodes (groups) for visual clustering
//   - Auto-generated edges from real architecture knowledge
//   - Live status + latency + cert info enrichment
app.get("/api/infra-graph", (_req, res) => {
  const now = new Date().toISOString();

  // ── 1. Build enriched target nodes ──────────────────────────────────────
  const targetNodes = TARGETS.map((t) => {
    const check = cache.get(t.id) || { status: "UNKNOWN", error: "PENDING_FIRST_CHECK" };
    const nodeIncidents = incidents.filter(i => i.id === t.id).slice(0, 5);
    const ut = uptimeChecks.get(t.id);
    const cert = certCache.get((() => { try { return new URL(t.url).hostname; } catch { return ""; } })());
    const lh = latencyHistory.get(t.id) || [];
    return {
      data: {
        id: t.id,
        label: `${t.icon || ""} ${t.name}`,
        type: t.type || "service",
        status: check.status,
        parent: t.group, // compound node grouping
        diagnostic: check.error || check.diagnosis?.message || null,
        diagCode: check.diagnosis?.code || null,
        failedAt: check.diagnosis?.failedAt || null,
        incidents: nodeIncidents,
        url: t.url,
        httpCode: check.httpCode || null,
        latency: check.latency || null,
        latencyHistory: lh,
        latencyAvg: lh.length > 0 ? Math.round(lh.reduce((a, b) => a + b, 0) / lh.length) : null,
        latencyP95: lh.length > 2 ? lh.slice().sort((a, b) => a - b)[Math.floor(lh.length * 0.95)] : null,
        uptime: ut && ut.total > 0 ? ((ut.up / ut.total) * 100).toFixed(1) : null,
        certDaysLeft: cert?.daysLeft || null,
        certIssuer: cert?.issuer || null,
        group: t.group,
        icon: t.icon,
      }
    };
  });

  // ── 2. Virtual infrastructure nodes (not monitored, but real) ───────────
  const infraNodes = [
    { data: { id: "hetzner",       label: "☁️ Hetzner Cloud",     type: "cloud",    status: "INFRA", tier: "cloud" } },
    { data: { id: "k3s-cluster",   label: "⎈ K3s Cluster",       type: "k8s",      status: "INFRA", tier: "platform" } },
    { data: { id: "traefik",       label: "🔀 Traefik Ingress",   type: "ingress",  status: "INFRA", tier: "platform" } },
    { data: { id: "letsencrypt",   label: "🔒 Let's Encrypt",     type: "ca",       status: "INFRA", tier: "external" } },
    { data: { id: "firebase",      label: "🔥 Firebase / GCP",    type: "cloud",    status: "INFRA", tier: "external" } },
    { data: { id: "discord",       label: "💬 Discord Webhooks",  type: "external", status: "INFRA", tier: "external" } },
    { data: { id: "prometheus",    label: "📊 Prometheus",        type: "monitoring", status: "INFRA", parent: "INFRA", tier: "platform" } },
    { data: { id: "loki",          label: "📜 Loki",              type: "monitoring", status: "INFRA", parent: "INFRA", tier: "platform" } },
  ];

  // ── 3. Group (compound) nodes ───────────────────────────────────────────
  const groups = [...new Set(TARGETS.map(t => t.group))];
  const groupColors = {
    "ALERT-IMMO": "#00ff41", "EXAM-DRILL": "#00aaff", "CAPIPILOT": "#ff9ff3",
    "IMPACTDROIT": "#feca57", "RENT-APPLY": "#0abde3", "INFRA": "#636e72",
  };
  const groupNodes = groups.map(g => ({
    data: {
      id: g,
      label: g,
      type: "group",
      status: "GROUP",
      color: groupColors[g] || "#555",
    }
  }));

  // ── 4. Edges — real architecture topology ───────────────────────────────
  const edges = [];
  const edge = (src, tgt, type, critical = false, label = "") =>
    edges.push({ data: { source: src, target: tgt, type, critical, label } });

  // Cloud → Platform
  edge("hetzner", "k3s-cluster", "hosts", true);
  edge("k3s-cluster", "traefik", "runs", true);

  // Traefik routes → all apps on K3s (*.delpech.dev + custom domains)
  const k3sApps = [
    "alert-immo-gateway", "alert-immo-system", "alert-immo-frontend",
    "exam-drill-api", "impactdroit-api", "impactdroit-analyzer", "impactdroit-frontend",
    "rent-apply-web",
    "grafana", "sitrep",
  ];
  for (const appId of k3sApps) {
    if (TARGETS.find(t => t.id === appId)) {
      edge("traefik", appId, "routes", true);
    }
  }

  // Alert-Immo internal: frontend → gateway → backends
  edge("alert-immo-frontend", "alert-immo-gateway", "api-call", true);
  edge("alert-immo-gateway", "alert-immo-system", "health-agg", false);

  // ImpactDroit: frontend → api, api → analyzer
  edge("impactdroit-frontend", "impactdroit-api", "api-call", true);
  edge("impactdroit-api", "impactdroit-analyzer", "analysis", true);

  // Capipilot: hosted on Firebase/GCP (not K3s)
  edge("firebase", "capipilot-api", "hosts", true);

  // Rent-Apply: self-hosted on K3s (rent-apply.delpech.dev)
  edge("rent-apply-web", "rent-apply-health", "health-agg", false);

  // TLS: Let's Encrypt → Traefik (cert-manager)
  edge("letsencrypt", "traefik", "issues-certs", false, "cert-manager");

  // Monitoring: Grafana ← Prometheus, Grafana ← Loki
  edge("prometheus", "grafana", "data-source", false);
  edge("loki", "grafana", "data-source", false);

  // SITREP → Discord alerts
  edge("sitrep", "discord", "alerts", false);

  // SITREP monitors everything (dotted, non-critical)
  for (const t of TARGETS) {
    if (t.id !== "sitrep") {
      edge("sitrep", t.id, "monitors", false);
    }
  }

  // ── 5. Assemble ─────────────────────────────────────────────────────────
  const allNodes = [...groupNodes, ...infraNodes, ...targetNodes];

  res.json({ timestamp: now, nodes: allNodes, edges });
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

// ============================================================================
// MONITORING HUB — Multi-Source Infrastructure Intelligence
// ============================================================================
// Aggregates: GitHub (PRs, CI, commits), Code Intelligence (Neo4j),
//             Finance/Budget, Notion (roadmap, planning), Infra Health
// ============================================================================

// ── API: Monitoring Dashboard (all modules) ─────────────────────────────────
app.get("/api/monitoring/dashboard", (_req, res) => {
  try {
    const dashboard = monitoringHub.getDashboard();
    res.json(dashboard);
  } catch (err) {
    log.error({ err: err.message }, "Monitoring dashboard failed");
    res.status(500).json({ error: "Monitoring dashboard unavailable" });
  }
});

// ── API: Per-Project Unified View ───────────────────────────────────────────
app.get("/api/monitoring/project/:projectName", (req, res) => {
  const { projectName } = req.params;
  try {
    const view = monitoringHub.getProjectView(projectName);
    res.json(view);
  } catch (err) {
    log.error({ err: err.message, project: projectName }, "Project view failed");
    res.status(500).json({ error: `Project view unavailable: ${projectName}` });
  }
});

// ── API: GitHub Module ──────────────────────────────────────────────────────
app.get("/api/monitoring/github", (_req, res) => {
  try {
    const github = require("./lib/collectors/github");
    res.json(github.getSummary());
  } catch (err) {
    res.status(503).json({ error: "GitHub collector not available", message: err.message });
  }
});

app.get("/api/monitoring/github/:repo", (req, res) => {
  try {
    const github = require("./lib/collectors/github");
    const detail = github.getRepoDetail(req.params.repo);
    if (!detail?.stats) return res.status(404).json({ error: `Repo not found: ${req.params.repo}` });
    res.json(detail);
  } catch (err) {
    res.status(503).json({ error: "GitHub collector not available" });
  }
});

// ── API: Code Intelligence Module ───────────────────────────────────────────
app.get("/api/monitoring/code", (_req, res) => {
  try {
    const codeIntel = require("./lib/collectors/code-intelligence");
    res.json(codeIntel.getSummary());
  } catch (err) {
    res.status(503).json({ error: "Code Intelligence not available", message: err.message });
  }
});

app.get("/api/monitoring/code/:project", (req, res) => {
  try {
    const codeIntel = require("./lib/collectors/code-intelligence");
    const detail = codeIntel.getProjectDetail(req.params.project);
    if (!detail) return res.status(404).json({ error: `Project not found: ${req.params.project}` });
    res.json(detail);
  } catch (err) {
    res.status(503).json({ error: "Code Intelligence not available" });
  }
});

// ── API: Finance / Budget Module ────────────────────────────────────────────
app.get("/api/monitoring/finance", (_req, res) => {
  try {
    const finance = require("./lib/collectors/finance");
    res.json(finance.getSummary());
  } catch (err) {
    res.status(503).json({ error: "Finance collector not available", message: err.message });
  }
});

// ── API: Notion / Roadmap Module ────────────────────────────────────────────
app.get("/api/monitoring/roadmap", (_req, res) => {
  try {
    const notionSync = require("./lib/collectors/notion-sync");
    res.json(notionSync.getSummary());
  } catch (err) {
    res.status(503).json({ error: "Notion sync not available", message: err.message });
  }
});

// ── API: Monitoring Hub Refresh ─────────────────────────────────────────────
app.post("/api/monitoring/refresh", async (_req, res) => {
  try {
    await monitoringHub.stop();
    await monitoringHub.start();
    res.json({ ok: true, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: "Refresh failed", message: err.message });
  }
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
  }, `SITREP v2.2 online — http://localhost:${PORT}`);

  emitEvent("STARTUP", "info", null,
    `SITREP v2.2 online — ${TARGETS.length} targets, poll every ${POLL_INTERVAL / 1000}s`,
    { port: PORT, targets: TARGETS.length, pollInterval: POLL_INTERVAL, mockMode: MOCK_MODE });

  pollAll();
  setInterval(pollAll, POLL_INTERVAL);

  // SSL cert check on startup + every 6h
  pollCerts();
  setInterval(pollCerts, CERT_CHECK_INTERVAL);

  // Start Monitoring Hub (GitHub, Code Intelligence, Finance, Notion)
  monitoringHub.start().catch((err) => {
    log.error({ err: err.message }, "Monitoring Hub failed to start — continuing without collectors");
  });
});

// ── Graceful shutdown (K8s SIGTERM) ─────────────────────────────────────────
function gracefulShutdown(signal) {
  log.info({ signal }, "Shutting down gracefully...");
  // Persist incidents before exit
  saveIncidents(incidents);
  // Stop monitoring hub collectors
  monitoringHub.stop().catch(() => {});
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
