// ============================================================================
// SITREP — Frontend Logic v2.2
// ============================================================================
// Features: dynamic favicon, push notifications, alert sounds, sparklines,
//           uptime %, countdown bar, cert expiry, persistent incident log
// ============================================================================

const POLL_MS = 30_000;
let prevStatuses = {};
let soundEnabled = true;
let notificationsEnabled = false;
let countdownTimer = null;

// ── Audio context for military alert ────────────────────────────────────────
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function playAlertSound(type) {
  if (!soundEnabled) return;
  if (!audioCtx) audioCtx = new AudioCtx();

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);

  if (type === "DOWN") {
    // Urgent klaxon: two-tone alarm
    osc.type = "square";
    osc.frequency.setValueAtTime(800, audioCtx.currentTime);
    osc.frequency.setValueAtTime(600, audioCtx.currentTime + 0.15);
    osc.frequency.setValueAtTime(800, audioCtx.currentTime + 0.3);
    osc.frequency.setValueAtTime(600, audioCtx.currentTime + 0.45);
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.6);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.6);
  } else if (type === "OPERATIONAL") {
    // Recovery chime: pleasant ascending
    osc.type = "sine";
    osc.frequency.setValueAtTime(523, audioCtx.currentTime);
    osc.frequency.setValueAtTime(659, audioCtx.currentTime + 0.1);
    osc.frequency.setValueAtTime(784, audioCtx.currentTime + 0.2);
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.4);
  } else {
    // Degraded: single warning tone
    osc.type = "triangle";
    osc.frequency.setValueAtTime(440, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.3);
  }
}

// ── Dynamic Favicon ─────────────────────────────────────────────────────────
function updateFavicon(status) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#0a0e0a";
  ctx.beginPath();
  ctx.arc(32, 32, 32, 0, Math.PI * 2);
  ctx.fill();

  const color = status === "DOWN" ? "#ff3333"
    : status === "DEGRADED" ? "#ffaa00"
    : status === "UNKNOWN" ? "#666666"
    : "#00ff41";

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(32, 32, 20, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(32, 32, 28, 0, Math.PI * 2);
  ctx.stroke();

  const link = document.querySelector("link[rel='icon']") || document.createElement("link");
  link.rel = "icon";
  link.href = canvas.toDataURL();
  document.head.appendChild(link);

  const prefix = status === "DOWN" ? "🔴" : status === "DEGRADED" ? "🟡" : "🟢";
  document.title = `${prefix} SITREP — Tactical Ops`;
}

// ── Browser Notifications ───────────────────────────────────────────────────
async function requestNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") { notificationsEnabled = true; return; }
  if (Notification.permission !== "denied") {
    const perm = await Notification.requestPermission();
    notificationsEnabled = perm === "granted";
  }
}

function sendNotification(target, from, to) {
  if (!notificationsEnabled) return;
  const icon = to === "DOWN" ? "🔴" : to === "OPERATIONAL" ? "🟢" : "🟡";
  new Notification(`SITREP — ${target.name}`, {
    body: `${icon} ${from} → ${to}\n${target.group}`,
    tag: target.id,
    requireInteraction: to === "DOWN",
  });
}

// ── Sparkline SVG generator ─────────────────────────────────────────────────
function sparklineSVG(values, width = 120, height = 28) {
  if (!values || values.length < 2) return "";
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;

  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  const lastVal = values[values.length - 1];
  const dotColor = lastVal < 500 ? "var(--green)" : lastVal < 2000 ? "var(--amber)" : "var(--red)";
  const lastX = width;
  const lastY = height - ((lastVal - min) / range) * (height - 4) - 2;

  return `<svg viewBox="0 0 ${width} ${height}" class="sparkline" width="${width}" height="${height}">
    <polyline points="${points}" fill="none" stroke="var(--green-dim)" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.5" fill="${dotColor}"/>
  </svg>`;
}

// ── Countdown progress bar ──────────────────────────────────────────────────
function startCountdown() {
  const bar = document.getElementById("countdownBar");
  if (!bar) return;
  let elapsed = 0;
  const step = 100;
  if (countdownTimer) clearInterval(countdownTimer);
  bar.style.width = "0%";
  countdownTimer = setInterval(() => {
    elapsed += step;
    const pct = Math.min((elapsed / POLL_MS) * 100, 100);
    bar.style.width = `${pct}%`;
    if (elapsed >= POLL_MS) elapsed = 0;
  }, step);
}

// ── Clock ─────────────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  document.getElementById("clock").textContent = `${hh}:${mm}:${ss}`;
  const utc = now.toUTCString().replace("GMT", "ZULU");
  document.getElementById("zulu").textContent = utc;
}
setInterval(updateClock, 1000);
updateClock();

// ── Fetch status ──────────────────────────────────────────────────────────
async function fetchStatus() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("[SITREP] Fetch failed:", err);
    return null;
  }
}

// ── Render ─────────────────────────────────────────────────────────────────
function render(data) {
  if (!data) return;

  document.getElementById("totalCount").textContent = data.summary.total;
  document.getElementById("opCount").textContent = data.summary.operational;
  document.getElementById("degCount").textContent = data.summary.degraded;
  document.getElementById("downCount").textContent = data.summary.down;

  const now = new Date(data.timestamp);
  document.getElementById("lastSweep").textContent =
    `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;

  const banner = document.getElementById("overallBanner");
  const bannerIcon = document.getElementById("bannerIcon");
  const bannerText = document.getElementById("bannerText");
  banner.classList.remove("all-clear", "has-degraded", "has-down");

  let overallStatus = "OPERATIONAL";
  if (data.summary.down > 0) {
    banner.classList.add("has-down");
    bannerIcon.textContent = "⚠";
    bannerText.textContent = `CONDITION RED — ${data.summary.down} ASSET${data.summary.down > 1 ? "S" : ""} DOWN`;
    overallStatus = "DOWN";
  } else if (data.summary.degraded > 0) {
    banner.classList.add("has-degraded");
    bannerIcon.textContent = "◈";
    bannerText.textContent = `CONDITION AMBER — ${data.summary.degraded} ASSET${data.summary.degraded > 1 ? "S" : ""} DEGRADED`;
    overallStatus = "DEGRADED";
  } else if (data.summary.unknown > 0) {
    banner.classList.add("has-degraded");
    bannerIcon.textContent = "◇";
    bannerText.textContent = "RECONNAISSANCE IN PROGRESS...";
    overallStatus = "UNKNOWN";
  } else {
    banner.classList.add("all-clear");
    bannerIcon.textContent = "◉";
    bannerText.textContent = "ALL SYSTEMS OPERATIONAL — CONDITION GREEN";
  }

  updateFavicon(overallStatus);

  const groups = {};
  for (const t of data.targets) {
    if (!groups[t.group]) groups[t.group] = [];
    groups[t.group].push(t);
  }

  const grid = document.getElementById("grid");
  grid.innerHTML = "";

  for (const [groupName, targets] of Object.entries(groups)) {
    const groupHeader = document.createElement("div");
    groupHeader.className = "group-header";
    const opInGroup = targets.filter(t => t.status === "OPERATIONAL").length;
    groupHeader.innerHTML = `
      <span class="group-name">▸ ${groupName}</span>
      <span class="group-line"></span>
      <span class="group-count">${opInGroup}/${targets.length} NOMINAL</span>
    `;
    grid.appendChild(groupHeader);

    for (const t of targets) {
      const card = document.createElement("div");
      card.className = `card status-${t.status}`;

      const latencyClass = !t.latency ? "" : t.latency < 500 ? "fast" : t.latency < 2000 ? "medium" : "slow";
      const latencyDisplay = t.latency != null ? `${t.latency}ms` : "—";
      const httpDisplay = t.httpCode || "—";
      const lastCheckDisplay = t.lastCheck ? new Date(t.lastCheck).toLocaleTimeString("fr-FR") : "—";

      const uptimeDisplay = t.uptime != null ? `${t.uptime}%` : "—";
      const uptimeClass = t.uptime == null ? "" : t.uptime >= 99.5 ? "fast" : t.uptime >= 95 ? "medium" : "slow";

      let certHtml = "";
      if (t.certInfo) {
        const days = t.certInfo.daysLeft;
        const certClass = days > 30 ? "fast" : days > 7 ? "medium" : "slow";
        certHtml = `
          <div class="metric">
            <span class="metric-label">🔐 CERT</span>
            <span class="metric-value ${certClass}">${days}d</span>
          </div>`;
      }

      const sparkline = sparklineSVG(t.latencyHistory);
      const sparkHtml = sparkline ? `<div class="card-sparkline">${sparkline}</div>` : "";

      // Composite sub-components rendering (for gateway aggregated health)
      let componentsHtml = "";
      if (t.type === "composite" && t.components) {
        const comps = Object.entries(t.components);
        const compItems = comps.map(([key, comp]) => {
          const st = comp.status || "UNKNOWN";
          const statusClass = st === "UP" ? "comp-up" : st === "DOWN" ? "comp-down" : "comp-degraded";
          const criticalBadge = comp.critical ? "●" : "○";
          const latMs = comp.latencyMs != null ? `${comp.latencyMs}ms` : "";
          const errorTip = comp.error ? ` title="${comp.error}"` : "";
          return `<div class="comp-row ${statusClass}"${errorTip}>
            <span class="comp-critical">${criticalBadge}</span>
            <span class="comp-name">${comp.name || key}</span>
            <span class="comp-status">${st}</span>
            <span class="comp-latency">${latMs}</span>
          </div>`;
        }).join("");
        componentsHtml = `<div class="composite-panel">${compItems}</div>`;
      }

      // Legacy Spring Boot actuator details (non-composite)
      let detailsHtml = "";
      if (!componentsHtml && t.details && t.details.components) {
        const comps = Object.entries(t.details.components);
        const compItems = comps.map(([name, info]) => {
          const st = info.status || "UNKNOWN";
          const stClass = st === "UP" ? "fast" : st === "DOWN" ? "slow" : "medium";
          return `<span class="metric-value ${stClass}" title="${name}">${name.substring(0, 8)}: ${st}</span>`;
        }).join("");
        if (compItems) detailsHtml = `<div class="card-details">${compItems}</div>`;
      }

      card.innerHTML = `
        <div class="card-header">
          <div class="card-title">
            <span class="card-icon">${t.icon || "◉"}</span>
            <span class="card-name">${t.name}</span>
          </div>
          <div class="card-badges">
            <span class="uptime-badge ${uptimeClass}" title="Uptime since monitoring started">${uptimeDisplay}</span>
            <span class="card-group">${t.group}</span>
          </div>
        </div>
        <div class="card-status">
          <span class="status-dot ${t.status}"></span>
          <span class="status-label ${t.status}">${t.status}</span>
        </div>
        ${sparkHtml}
        <div class="card-metrics">
          <div class="metric">
            <span class="metric-label">LATENCY</span>
            <span class="metric-value ${latencyClass}">${latencyDisplay}</span>
          </div>
          <div class="metric">
            <span class="metric-label">HTTP</span>
            <span class="metric-value">${httpDisplay}</span>
          </div>
          <div class="metric">
            <span class="metric-label">UPTIME</span>
            <span class="metric-value ${uptimeClass}">${uptimeDisplay}</span>
          </div>
          <div class="metric">
            <span class="metric-label">LAST CHECK</span>
            <span class="metric-value">${lastCheckDisplay}</span>
          </div>
          ${certHtml}
        </div>
        ${detailsHtml}
        ${componentsHtml}
        ${t.error ? `<div class="card-error">✖ ${t.error}</div>` : ""}
        <div class="card-url" title="${t.url}">${t.url}</div>
      `;

      grid.appendChild(card);

      const prev = prevStatuses[t.id];
      if (prev && prev !== t.status) {
        addLog(t, prev, t.status);
        playAlertSound(t.status);
        sendNotification(t, prev, t.status);
      }
    }
  }

  for (const t of data.targets) {
    prevStatuses[t.id] = t.status;
  }
}

// ── Incident log ──────────────────────────────────────────────────────────
function addLog(target, from, to) {
  const logBody = document.getElementById("logBody");
  const entry = document.createElement("div");
  const ts = new Date().toLocaleTimeString("fr-FR");
  let cls = to === "DOWN" ? "down" : to === "DEGRADED" ? "degraded" : to === "OPERATIONAL" ? "up" : "info";
  entry.className = `log-entry ${cls}`;
  entry.textContent = `[${ts}] ${target.icon} ${target.name} (${target.group}): ${from} → ${to}`;
  logBody.prepend(entry);
  while (logBody.children.length > 50) logBody.removeChild(logBody.lastChild);

  const badge = document.getElementById("incidentBadge");
  if (badge) {
    const count = parseInt(badge.textContent || "0") + 1;
    badge.textContent = count;
    badge.style.display = "inline-flex";
  }
}

// ── Load server-side incidents on boot ────────────────────────────────────
async function loadIncidents() {
  try {
    const res = await fetch("/api/incidents");
    const data = await res.json();
    const logBody = document.getElementById("logBody");
    for (const inc of data.incidents.slice(0, 30)) {
      const entry = document.createElement("div");
      const ts = new Date(inc.at).toLocaleTimeString("fr-FR");
      let cls = inc.to === "DOWN" ? "down" : inc.to === "DEGRADED" ? "degraded" : inc.to === "OPERATIONAL" ? "up" : "info";
      entry.className = `log-entry ${cls}`;
      entry.textContent = `[${ts}] ${inc.icon} ${inc.name} (${inc.group}): ${inc.from} → ${inc.to}`;
      logBody.appendChild(entry);
    }
  } catch { /* first boot */ }
}

// ── UI Controls ───────────────────────────────────────────────────────────
document.getElementById("logToggle")?.addEventListener("click", (e) => {
  e.stopPropagation();
  document.getElementById("incidentLog").classList.toggle("collapsed");
  e.target.textContent = document.getElementById("incidentLog").classList.contains("collapsed") ? "▸" : "▾";
});
document.getElementById("logHeader")?.addEventListener("click", () => {
  document.getElementById("incidentLog").classList.toggle("collapsed");
});

document.getElementById("soundToggle")?.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  const btn = document.getElementById("soundToggle");
  btn.textContent = soundEnabled ? "🔊" : "🔇";
  btn.title = soundEnabled ? "Alerts: ON" : "Alerts: OFF";
});

document.getElementById("notifToggle")?.addEventListener("click", async () => {
  if (!notificationsEnabled) await requestNotificationPermission();
  else notificationsEnabled = false;
  const btn = document.getElementById("notifToggle");
  btn.textContent = notificationsEnabled ? "🔔" : "🔕";
  btn.title = notificationsEnabled ? "Notifications: ON" : "Notifications: OFF";
});

document.getElementById("refreshBtn")?.addEventListener("click", async () => {
  const btn = document.getElementById("refreshBtn");
  btn.classList.add("spinning");
  btn.disabled = true;
  try {
    await fetch("/api/status/refresh", { method: "POST" });
    const data = await fetchStatus();
    render(data);
    startCountdown();
  } finally {
    btn.classList.remove("spinning");
    btn.disabled = false;
  }
});

// ── Main loop ─────────────────────────────────────────────────────────────
async function loop() {
  const data = await fetchStatus();
  render(data);
  startCountdown();
}

loop();
loadIncidents();
setInterval(loop, POLL_MS);

document.addEventListener("click", () => requestNotificationPermission(), { once: true });

// ── Keyboard shortcuts ────────────────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.key === "r" || e.key === "R") document.getElementById("refreshBtn").click();
  if (e.key === "m" || e.key === "M") document.getElementById("soundToggle")?.click();
  if (e.key === "n" || e.key === "N") document.getElementById("notifToggle")?.click();
  if (e.key === "?" || e.key === "h") {
    const help = document.getElementById("helpModal");
    if (help) help.classList.toggle("visible");
  }
});
