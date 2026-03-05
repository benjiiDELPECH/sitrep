// ============================================================================
// SITREP — Frontend Logic
// ============================================================================

const POLL_MS = 30_000;
let prevStatuses = {};

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

  // Summary
  document.getElementById("totalCount").textContent = data.summary.total;
  document.getElementById("opCount").textContent = data.summary.operational;
  document.getElementById("degCount").textContent = data.summary.degraded;
  document.getElementById("downCount").textContent = data.summary.down;

  const now = new Date(data.timestamp);
  document.getElementById("lastSweep").textContent =
    `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;

  // Overall banner
  const banner = document.getElementById("overallBanner");
  const bannerIcon = document.getElementById("bannerIcon");
  const bannerText = document.getElementById("bannerText");
  banner.classList.remove("all-clear", "has-degraded", "has-down");

  if (data.summary.down > 0) {
    banner.classList.add("has-down");
    bannerIcon.textContent = "⚠";
    bannerText.textContent = `CONDITION RED — ${data.summary.down} ASSET${data.summary.down > 1 ? "S" : ""} DOWN`;
  } else if (data.summary.degraded > 0) {
    banner.classList.add("has-degraded");
    bannerIcon.textContent = "◈";
    bannerText.textContent = `CONDITION AMBER — ${data.summary.degraded} ASSET${data.summary.degraded > 1 ? "S" : ""} DEGRADED`;
  } else if (data.summary.unknown > 0) {
    banner.classList.add("has-degraded");
    bannerIcon.textContent = "◇";
    bannerText.textContent = "RECONNAISSANCE IN PROGRESS...";
  } else {
    banner.classList.add("all-clear");
    bannerIcon.textContent = "◉";
    bannerText.textContent = "ALL SYSTEMS OPERATIONAL — CONDITION GREEN";
  }

  // Group targets
  const groups = {};
  for (const t of data.targets) {
    if (!groups[t.group]) groups[t.group] = [];
    groups[t.group].push(t);
  }

  // Render grid
  const grid = document.getElementById("grid");
  grid.innerHTML = "";

  for (const [groupName, targets] of Object.entries(groups)) {
    // Group header
    const groupHeader = document.createElement("div");
    groupHeader.className = "group-header";
    const opInGroup = targets.filter(t => t.status === "OPERATIONAL").length;
    groupHeader.innerHTML = `
      <span class="group-name">▸ ${groupName}</span>
      <span class="group-line"></span>
      <span class="group-count">${opInGroup}/${targets.length} NOMINAL</span>
    `;
    grid.appendChild(groupHeader);

    // Cards
    for (const t of targets) {
      const card = document.createElement("div");
      card.className = `card status-${t.status}`;

      const latencyClass = !t.latency ? "" : t.latency < 500 ? "fast" : t.latency < 2000 ? "medium" : "slow";
      const latencyDisplay = t.latency != null ? `${t.latency}ms` : "—";
      const httpDisplay = t.httpCode || "—";
      const lastCheckDisplay = t.lastCheck
        ? new Date(t.lastCheck).toLocaleTimeString("fr-FR")
        : "—";

      // Spring Boot actuator details
      let detailsHtml = "";
      if (t.details && t.details.components) {
        const comps = Object.entries(t.details.components);
        const compItems = comps.map(([name, info]) => {
          const st = info.status || "UNKNOWN";
          const stClass = st === "UP" ? "fast" : st === "DOWN" ? "slow" : "medium";
          return `<span class="metric-value ${stClass}" title="${name}">${name.substring(0, 8)}: ${st}</span>`;
        }).join("");
        if (compItems) {
          detailsHtml = `<div class="card-details" style="margin-top:8px;font-size:10px;display:flex;gap:8px;flex-wrap:wrap;">${compItems}</div>`;
        }
      }

      card.innerHTML = `
        <div class="card-header">
          <div class="card-title">
            <span class="card-icon">${t.icon || "◉"}</span>
            <span class="card-name">${t.name}</span>
          </div>
          <span class="card-group">${t.group}</span>
        </div>
        <div class="card-status">
          <span class="status-dot ${t.status}"></span>
          <span class="status-label ${t.status}">${t.status}</span>
        </div>
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
            <span class="metric-label">TYPE</span>
            <span class="metric-value">${t.type || "—"}</span>
          </div>
          <div class="metric">
            <span class="metric-label">LAST CHECK</span>
            <span class="metric-value">${lastCheckDisplay}</span>
          </div>
        </div>
        ${detailsHtml}
        ${t.error ? `<div class="card-error">✖ ${t.error}</div>` : ""}
        <div class="card-url" title="${t.url}">${t.url}</div>
      `;

      grid.appendChild(card);

      // Detect transitions → log
      const prev = prevStatuses[t.id];
      if (prev && prev !== t.status) {
        addLog(t, prev, t.status);
      }
    }
  }

  // Save for next diff
  for (const t of data.targets) {
    prevStatuses[t.id] = t.status;
  }
}

// ── Incident log ──────────────────────────────────────────────────────────
function addLog(target, from, to) {
  const logBody = document.getElementById("logBody");
  const entry = document.createElement("div");
  const ts = new Date().toLocaleTimeString("fr-FR");

  let cls = "info";
  let arrow = "→";
  if (to === "DOWN") cls = "down";
  else if (to === "DEGRADED") cls = "degraded";
  else if (to === "OPERATIONAL") cls = "up";

  entry.className = `log-entry ${cls}`;
  entry.textContent = `[${ts}] ${target.icon} ${target.name} (${target.group}): ${from} ${arrow} ${to}`;

  logBody.prepend(entry);

  // Keep max 50 entries
  while (logBody.children.length > 50) {
    logBody.removeChild(logBody.lastChild);
  }
}

// ── Incident log toggle ──────────────────────────────────────────────────
document.getElementById("logToggle").addEventListener("click", (e) => {
  e.stopPropagation();
  document.getElementById("incidentLog").classList.toggle("collapsed");
  e.target.textContent = document.getElementById("incidentLog").classList.contains("collapsed") ? "▸" : "▾";
});
document.getElementById("logHeader")?.addEventListener("click", () => {
  document.getElementById("incidentLog").classList.toggle("collapsed");
});

// ── Refresh button ────────────────────────────────────────────────────────
document.getElementById("refreshBtn").addEventListener("click", async () => {
  const btn = document.getElementById("refreshBtn");
  btn.classList.add("spinning");
  btn.disabled = true;

  try {
    await fetch("/api/status/refresh", { method: "POST" });
    const data = await fetchStatus();
    render(data);
  } finally {
    btn.classList.remove("spinning");
    btn.disabled = false;
  }
});

// ── Main loop ─────────────────────────────────────────────────────────────
async function loop() {
  const data = await fetchStatus();
  render(data);
}

// Start
loop();
setInterval(loop, POLL_MS);

// ── Keyboard shortcut ─────────────────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.key === "r" || e.key === "R") {
    document.getElementById("refreshBtn").click();
  }
});
