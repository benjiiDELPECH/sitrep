// ============================================================================
// SITREP — Multi-App Business Dashboard
// ============================================================================
// Vanilla JS — zero dependencies. Military theme.
// Loads app registry from /api/apps, renders per-app dashboards.
// ============================================================================

const REFRESH_MS = 30_000;
let currentAppId = null;
let appsRegistry = [];
let refreshTimer = null;

// ── Clock ───────────────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  const el = document.getElementById("clock");
  if (el) el.textContent = now.toLocaleTimeString("fr-FR", { hour12: false });
}
setInterval(updateClock, 1000);
updateClock();

// ── Fetch helper ────────────────────────────────────────────────────────────
async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Shared colors ───────────────────────────────────────────────────────────
const VERDICT_COLORS = {
  BONNE_AFFAIRE: "#00ff41",
  PRIX_CORRECT: "#00aaff",
  LEGERE_SURCOTE: "#ffaa00",
  SURPAYE: "#ff3333",
  FORTE_SURCOTE: "#ff0000",
  INDETERMINE: "#666666",
};

const DPE_COLORS = {
  A: "#009c3b", B: "#33cc66", C: "#99cc33", D: "#ffcc00",
  E: "#ff9900", F: "#ff5500", G: "#ff0000", "N/A": "#444444",
};

// ── Format helpers ──────────────────────────────────────────────────────────
function fmt(n) { return n != null ? n.toLocaleString("fr-FR") : "--"; }
function pct(n) { return n != null ? n.toFixed(1) + "%" : "--"; }
function eur(n) { return n != null ? n.toLocaleString("fr-FR") + " €" : "--"; }
function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function timeSince(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "min";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  return Math.floor(h / 24) + "j";
}

// ── Card builder helper ─────────────────────────────────────────────────────
function card(icon, title, bodyId, opts = {}) {
  const bodyStyle = opts.noPadding ? "padding:0;overflow-x:auto;" : "padding:12px;";
  return `
    <div class="card" style="padding:0;">
      <div class="card-header" style="padding:12px 16px;margin-bottom:0;border-bottom:1px solid #1a2e1a;">
        <span class="card-title"><span class="card-icon">${icon}</span> <span class="card-name">${title}</span></span>
      </div>
      <div class="card-body" id="${bodyId}" style="${bodyStyle}">
        <div class="loading">Chargement...</div>
      </div>
    </div>
  `;
}

// ============================================================================
// BOOT — Load app registry, render tabs, auto-select first
// ============================================================================
async function boot() {
  try {
    const data = await fetchJson("/api/apps");
    appsRegistry = data.apps || [];
    renderAppTabs();
    // Auto-select first app with a dashboard, or first app
    const defaultApp = appsRegistry.find((a) => a.dashboard) || appsRegistry[0];
    if (defaultApp) selectApp(defaultApp.id);
  } catch (err) {
    console.error("[ADMIN] Failed to load apps:", err);
    document.getElementById("appTabs").innerHTML =
      `<div style="color:#ff3333;padding:10px 14px;font-size:11px;">ERREUR: impossible de charger les applications</div>`;
  }
}

// ── Render App Tabs ─────────────────────────────────────────────────────────
function renderAppTabs() {
  const container = document.getElementById("appTabs");
  container.innerHTML = appsRegistry.map((app) => {
    const hasDash = !!app.dashboard;
    return `
      <button
        class="app-tab"
        data-app="${app.id}"
        onclick="selectApp('${app.id}')"
        style="
          padding:10px 16px;border:none;background:none;cursor:pointer;
          font-family:inherit;font-size:12px;letter-spacing:1px;
          color:${hasDash ? "#b0c4b0" : "#3a4e3a"};
          border-bottom:2px solid transparent;
          transition:all 0.2s;
        "
        title="${app.description || app.name}"
      >
        ${app.icon} ${app.name.toUpperCase()}
        ${!hasDash ? '<span style="font-size:8px;color:#3a4e3a;margin-left:4px;">●</span>' : ""}
      </button>
    `;
  }).join("");
}

// ── Select App ──────────────────────────────────────────────────────────────
function selectApp(appId) {
  currentAppId = appId;
  const app = appsRegistry.find((a) => a.id === appId);
  if (!app) return;

  // Update tab styles
  document.querySelectorAll(".app-tab").forEach((tab) => {
    const isActive = tab.dataset.app === appId;
    tab.style.color = isActive ? "#00ff41" : (appsRegistry.find(a => a.id === tab.dataset.app)?.dashboard ? "#b0c4b0" : "#3a4e3a");
    tab.style.borderBottomColor = isActive ? "#00ff41" : "transparent";
    tab.style.fontWeight = isActive ? "bold" : "normal";
  });

  // Update subtitle
  const subtitle = document.getElementById("pageSubtitle");
  if (subtitle) subtitle.textContent = `${app.icon} ${app.name.toUpperCase()} — BUSINESS DASHBOARD`;

  // Clear refresh timer
  if (refreshTimer) clearInterval(refreshTimer);

  // Render appropriate dashboard
  if (app.dashboard) {
    renderAppDashboard(app);
    loadAppData(app);
    refreshTimer = setInterval(() => loadAppData(app), REFRESH_MS);
  } else {
    renderNoDashboard(app);
    loadHealthOnly(app);
  }
}

// ============================================================================
// NO DASHBOARD — Show health status only
// ============================================================================
function renderNoDashboard(app) {
  document.getElementById("statusBar").style.display = "none";
  document.getElementById("mainContent").innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      ${card("📡", `${app.name.toUpperCase()} — SANTÉ DES SERVICES`, "healthTargets")}
      <div class="card" style="padding:0;">
        <div class="card-header" style="padding:12px 16px;margin-bottom:0;border-bottom:1px solid #1a2e1a;">
          <span class="card-title"><span class="card-icon">🔧</span> <span class="card-name">INFORMATIONS</span></span>
        </div>
        <div class="card-body" style="padding:20px;">
          <div style="color:#5a6e5a;font-size:12px;line-height:1.8;">
            <p style="margin:0 0 12px 0;color:#b0c4b0;">
              ${app.icon} <strong>${app.name}</strong>
            </p>
            <p style="margin:0 0 12px 0;">${app.description || "Aucune description."}</p>
            <div style="border:1px dashed #1a2e1a;border-radius:6px;padding:16px;margin-top:12px;text-align:center;">
              <div style="font-size:24px;margin-bottom:8px;">🚧</div>
              <div style="color:#ffaa00;font-size:11px;letter-spacing:1px;">DASHBOARD MÉTIER NON CONFIGURÉ</div>
              <div style="margin-top:6px;font-size:10px;">
                Ajoutez des endpoints <code>/api/admin/dashboard/*</code><br>
                sur le backend de ${app.name} pour activer ce dashboard.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function loadHealthOnly(app) {
  try {
    const data = await fetchJson(`/api/apps/${app.id}/health`);
    renderHealthTargets(data.targets || []);
  } catch (err) {
    const el = document.getElementById("healthTargets");
    if (el) el.innerHTML = `<p style="color:#ff3333;padding:12px;">Impossible de charger la santé des services</p>`;
  }
}

function renderHealthTargets(targets) {
  const el = document.getElementById("healthTargets");
  if (!el) return;
  if (!targets.length) {
    el.innerHTML = `<p style="color:#5a6e5a;padding:12px;">Aucun service monitoré</p>`;
    return;
  }
  el.innerHTML = targets.map((t) => {
    const color = t.status === "UP" ? "#00ff41" : t.status === "DEGRADED" ? "#ffaa00" : "#ff3333";
    const icon = t.status === "UP" ? "●" : t.status === "DEGRADED" ? "◐" : "○";
    return `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid #0d120d;">
        <span style="color:${color};font-size:16px;">${icon}</span>
        <span style="flex:1;font-size:12px;">${t.icon || ""} ${t.name}</span>
        <span style="color:${color};font-size:11px;font-weight:bold;">${t.status}</span>
        <span style="color:#5a6e5a;font-size:10px;min-width:60px;text-align:right;">${t.latency ? t.latency + "ms" : "--"}</span>
        <span style="color:#5a6e5a;font-size:10px;min-width:50px;text-align:right;">${t.uptime ? t.uptime + "%" : "--"}</span>
      </div>
    `;
  }).join("");
}

// ============================================================================
// APP WITH DASHBOARD — Build layout based on widgets config
// ============================================================================
function renderAppDashboard(app) {
  const w = app.dashboard.widgets || [];
  const statusBar = document.getElementById("statusBar");
  const main = document.getElementById("mainContent");

  // Show KPI bar
  statusBar.style.display = "flex";
  statusBar.innerHTML = `
    <div class="status-item"><span class="label">TOTAL</span><span class="value" id="kpiTotal">--</span></div>
    <div class="status-item operational"><span class="indicator bg-green"></span><span class="label">24H</span><span class="value" id="kpi24h">--</span></div>
    <div class="status-item"><span class="label">7J</span><span class="value" id="kpi7d">--</span></div>
  `;

  // Build layout dynamically based on available widgets
  let html = "";

  // Row 1: Quality + Distribution widgets
  const row1 = [];
  if (w.includes("quality")) row1.push(card("🎯", "SCORE QUALITÉ", "qualityBreakdown"));
  if (w.includes("verdicts")) row1.push(card("⚖️", "DISTRIBUTION VERDICTS", "verdictChart"));
  if (w.includes("dpe")) row1.push(card("🏷️", "DISTRIBUTION DPE", "dpeChart"));
  if (row1.length) {
    html += `<div style="display:grid;grid-template-columns:repeat(${row1.length}, 1fr);gap:16px;">${row1.join("")}</div>`;
  }

  // Row 2: Timeline + ADEME/Health
  const row2L = [];
  const row2R = [];
  if (w.includes("timeline")) row2L.push(card("📈", "ACTIVITÉ — 30 DERNIERS JOURS", "timelineContainer"));
  if (w.includes("ademe")) row2R.push(card("🏛️", "ADEME DPE — SANTÉ", "ademeHealth"));
  if (row2L.length || row2R.length) {
    const cols = row2L.length && row2R.length ? "2fr 1fr" : "1fr";
    html += `<div style="display:grid;grid-template-columns:${cols};gap:16px;">${row2L.join("")}${row2R.join("")}</div>`;
  }

  // Row 3: Agents
  if (w.includes("agents")) {
    html += card("🤖", "COUVERTURE AGENTS", "agentsTable", { noPadding: true });
  }

  // Row 4: Cities
  if (w.includes("cities")) {
    html += card("🗺️", "RÉPARTITION GÉOGRAPHIQUE — TOP 30", "cityMap");
  }

  // Row 5: Recent
  if (w.includes("recent")) {
    html += card("📋", "ACTIVITÉ RÉCENTE", "recentTable", { noPadding: true });
  }

  // Health section for dashboard apps too
  html += card("📡", `${app.name.toUpperCase()} — SANTÉ DES SERVICES`, "healthTargets");

  main.innerHTML = html;

  // Inject canvas if timeline widget present
  if (w.includes("timeline")) {
    const container = document.getElementById("timelineContainer");
    if (container) container.innerHTML = `<canvas id="timelineCanvas" height="180" style="width:100%;"></canvas>`;
  }
}

// ── Load all data for an app ────────────────────────────────────────────────
async function loadAppData(app) {
  const appId = app.id;
  const w = app.dashboard.widgets || [];
  const endpoints = app.dashboard.endpoints || [];

  try {
    // Build fetch list based on available endpoints
    const fetches = {};
    for (const ep of endpoints) {
      fetches[ep] = fetchJson(`/api/apps/${appId}/dashboard/${ep}`).catch(() => null);
    }
    if (app.dashboard.ademe) {
      fetches.ademe = fetchJson(`/api/apps/${appId}/ademe`).catch(() => null);
    }

    // Also fetch health
    fetches.health = fetchJson(`/api/apps/${appId}/health`).catch(() => null);

    // Await all
    const results = {};
    const keys = Object.keys(fetches);
    const values = await Promise.all(Object.values(fetches));
    keys.forEach((k, i) => results[k] = values[i]);

    // Check we're still on the same app
    if (currentAppId !== appId) return;

    // Render KPIs from overview
    if (results.overview) renderKPIs(results.overview, results.quality);

    // Render widgets
    if (w.includes("quality") && results.quality) renderQualityBreakdown(results.quality);
    if (w.includes("verdicts") && results["by-verdict"]) renderVerdicts(results["by-verdict"]);
    if (w.includes("dpe") && results["by-dpe"]) renderDpe(results["by-dpe"]);
    if (w.includes("timeline") && results.timeline) renderTimeline(results.timeline);
    if (w.includes("ademe") && results.ademe) renderAdemeHealth(results.ademe);
    if (w.includes("agents") && results.agents) renderAgents(results.agents, results.overview?.total || 0);
    if (w.includes("cities") && results["by-city"]) renderCityMap(results["by-city"]);
    if (w.includes("recent") && results.recent) renderRecent(results.recent);
    if (results.health) renderHealthTargets(results.health.targets || []);
  } catch (err) {
    console.error(`[ADMIN] Load failed for ${appId}:`, err);
  }
}

// ============================================================================
// WIDGET RENDERERS (mostly unchanged, now ID-targeted)
// ============================================================================

function renderKPIs(ov, q) {
  setText("kpiTotal", fmt(ov.total));
  setText("kpi24h", fmt(ov.last24h));
  setText("kpi7d", fmt(ov.last7d));

  // Dynamically add extra KPIs based on data
  const bar = document.getElementById("statusBar");
  // Remove old dynamic KPIs
  bar.querySelectorAll(".kpi-dynamic").forEach((el) => el.remove());

  const extras = [];
  if (ov.nbVilles != null) extras.push({ label: "VILLES", value: fmt(ov.nbVilles) });
  if (q?.score != null) {
    const color = q.score >= 80 ? "#00ff41" : q.score >= 50 ? "#ffaa00" : "#ff3333";
    extras.push({ label: "SCORE", value: q.score.toFixed(0) + "/100", color });
  }
  if (ov.ademeEnrichedPercent != null) extras.push({ label: "ADEME %", value: pct(ov.ademeEnrichedPercent) });
  if (ov.confidenceAPercent != null) extras.push({ label: "CONF. A", value: pct(ov.confidenceAPercent) });
  if (ov.avgRendementBrut != null) extras.push({ label: "REND. MOY", value: ov.avgRendementBrut.toFixed(1) + "%" });
  // Generic KPIs for any app
  if (ov.totalUsers != null) extras.push({ label: "UTILISATEURS", value: fmt(ov.totalUsers) });
  if (ov.activeUsers != null) extras.push({ label: "ACTIFS", value: fmt(ov.activeUsers) });

  extras.forEach((kpi) => {
    const div = document.createElement("div");
    div.className = "status-item kpi-dynamic";
    div.innerHTML = `<span class="label">${kpi.label}</span><span class="value" ${kpi.color ? `style="color:${kpi.color}"` : ""}>${kpi.value}</span>`;
    bar.appendChild(div);
  });
}

function renderQualityBreakdown(q) {
  const el = document.getElementById("qualityBreakdown");
  if (!el || !q.breakdown) {
    if (el) el.innerHTML = "<p style='color:#ff3333'>Pas de données</p>";
    return;
  }

  const items = Object.entries(q.breakdown).map(([key, val]) => {
    const label = {
      dvfEnriched: "DVF enrichi",
      rendementComputed: "Rendement calculé",
      dpePresent: "DPE renseigné",
      decompositionActive: "Décomposition active",
      intelligencePresent: "Intelligence LLM",
    }[key] || key;
    const barColor = val.percent >= 80 ? "#00ff41" : val.percent >= 50 ? "#ffaa00" : "#ff3333";
    return `
      <div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px;">
          <span>${label}</span>
          <span style="color:${barColor}">${val.count}/${q.total} (${pct(val.percent)}) — poids ${(val.weight * 100).toFixed(0)}%</span>
        </div>
        <div style="height:8px;background:#1a2e1a;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:${val.percent}%;background:${barColor};border-radius:4px;transition:width 0.5s;"></div>
        </div>
      </div>
    `;
  });

  const scoreColor = q.score >= 80 ? "#00ff41" : q.score >= 50 ? "#ffaa00" : "#ff3333";
  el.innerHTML = `
    <div style="text-align:center;margin-bottom:16px;">
      <div style="font-size:36px;font-weight:bold;color:${scoreColor};">${q.score?.toFixed(0) || "--"}</div>
      <div style="font-size:10px;color:#5a6e5a;letter-spacing:2px;">SCORE COMPOSITE / 100</div>
    </div>
    ${items.join("")}
  `;
}

function renderVerdicts(data) {
  const el = document.getElementById("verdictChart");
  if (!el) return;
  if (!data.length) { el.innerHTML = "<p style='color:#5a6e5a'>Aucune donnée</p>"; return; }
  const total = data.reduce((s, d) => s + d.count, 0);
  el.innerHTML = data.map(d => {
    const color = VERDICT_COLORS[d.verdict] || "#666";
    const w = (d.count / total * 100).toFixed(1);
    return `
      <div style="margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px;">
          <span style="color:${color}">● ${d.verdict.replace(/_/g, " ")}</span>
          <span>${d.count} (${w}%)${d.avgEcart != null ? ` — écart moy. ${d.avgEcart > 0 ? "+" : ""}${d.avgEcart}%` : ""}</span>
        </div>
        <div style="height:6px;background:#1a2e1a;border-radius:3px;overflow:hidden;">
          <div style="height:100%;width:${w}%;background:${color};border-radius:3px;"></div>
        </div>
      </div>
    `;
  }).join("");
}

function renderDpe(data) {
  const el = document.getElementById("dpeChart");
  if (!el) return;
  if (!data.length) { el.innerHTML = "<p style='color:#5a6e5a'>Aucune donnée</p>"; return; }
  const total = data.reduce((s, d) => s + d.count, 0);
  el.innerHTML = data.map(d => {
    const color = DPE_COLORS[d.dpe] || "#666";
    const w = (d.count / total * 100).toFixed(1);
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12px;">
        <div style="width:28px;height:28px;background:${color};border-radius:4px;display:flex;align-items:center;justify-content:center;font-weight:bold;color:#000;font-size:14px;">${d.dpe}</div>
        <div style="flex:1;">
          <div style="height:6px;background:#1a2e1a;border-radius:3px;overflow:hidden;">
            <div style="height:100%;width:${w}%;background:${color};border-radius:3px;"></div>
          </div>
        </div>
        <span style="min-width:80px;text-align:right;">${d.count} (${w}%)</span>
      </div>
    `;
  }).join("");
}

function renderTimeline(data) {
  const canvas = document.getElementById("timelineCanvas");
  if (!data.length || !canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = 180 * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width, H = 180;
  const pad = { top: 20, right: 16, bottom: 30, left: 40 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const maxCount = Math.max(...data.map(d => d.count), 1);
  const barW = Math.max(plotW / data.length - 2, 4);

  ctx.fillStyle = "#0d120d";
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = "#1a2e1a"; ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (plotH / 4) * i;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    ctx.fillStyle = "#5a6e5a"; ctx.font = "9px monospace"; ctx.textAlign = "right";
    ctx.fillText(Math.round(maxCount * (1 - i / 4)).toString(), pad.left - 4, y + 3);
  }

  data.forEach((d, i) => {
    const x = pad.left + (plotW / data.length) * i + 1;
    // Stacked if fields available, simple bar otherwise
    if (d.bonnesAffaires != null || d.surpaye != null) {
      const rest = d.count - (d.bonnesAffaires || 0) - (d.surpaye || 0);
      let cy = pad.top + plotH;
      ctx.fillStyle = "#00ff4180";
      const hBonne = ((d.bonnesAffaires || 0) / maxCount) * plotH;
      ctx.fillRect(x, cy - hBonne, barW, hBonne); cy -= hBonne;
      ctx.fillStyle = "#00aaff60";
      const hRest = (rest / maxCount) * plotH;
      ctx.fillRect(x, cy - hRest, barW, hRest); cy -= hRest;
      ctx.fillStyle = "#ff333380";
      const hSurpaye = ((d.surpaye || 0) / maxCount) * plotH;
      ctx.fillRect(x, cy - hSurpaye, barW, hSurpaye);
    } else {
      const h = (d.count / maxCount) * plotH;
      ctx.fillStyle = "#00aaff80";
      ctx.fillRect(x, pad.top + plotH - h, barW, h);
    }
    if (i % 5 === 0 || i === data.length - 1) {
      ctx.fillStyle = "#5a6e5a"; ctx.font = "8px monospace"; ctx.textAlign = "center";
      ctx.fillText((d.date || "").substring(5), x + barW / 2, H - pad.bottom + 14);
    }
  });
}

function renderAgents(data, totalAnalyses) {
  const el = document.getElementById("agentsTable");
  if (!el) return;
  if (!data.length) { el.innerHTML = "<p style='padding:12px;color:#5a6e5a'>Aucun agent</p>"; return; }
  const rows = data.map(a => {
    const coveragePct = totalAnalyses > 0 ? (a.activations / totalAnalyses * 100).toFixed(1) : "0";
    const barColor = a.avgImpact >= 0 ? "#00ff41" : a.avgImpact >= -3 ? "#ffaa00" : "#ff3333";
    const confColor = a.dominantConfidence === "HIGH" ? "#00ff41" : a.dominantConfidence === "MEDIUM" ? "#ffaa00" : "#ff3333";
    return `<tr>
      <td style="padding:6px 10px;font-size:11px;white-space:nowrap;">${a.agentId || a.id || "--"}</td>
      <td style="padding:6px 10px;font-size:11px;">${a.agentName || a.name || "--"}</td>
      <td style="padding:6px 10px;text-align:right;">${a.activations || 0}</td>
      <td style="padding:6px 10px;text-align:right;">${coveragePct}%</td>
      <td style="padding:6px 10px;text-align:right;color:${barColor}">${a.avgImpact != null ? (a.avgImpact > 0 ? "+" : "") + a.avgImpact + "%" : "--"}</td>
      <td style="padding:6px 10px;text-align:center;color:${confColor}">${a.dominantConfidence || "--"}</td>
    </tr>`;
  }).join("");
  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr style="border-bottom:1px solid #1a2e1a;color:#00ff41;font-size:10px;letter-spacing:1px;">
        <th style="padding:8px 10px;text-align:left;">ID</th>
        <th style="padding:8px 10px;text-align:left;">NOM</th>
        <th style="padding:8px 10px;text-align:right;">ACTIVATIONS</th>
        <th style="padding:8px 10px;text-align:right;">COUVERTURE</th>
        <th style="padding:8px 10px;text-align:right;">IMPACT MOY</th>
        <th style="padding:8px 10px;text-align:center;">CONFIANCE</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderCityMap(data) {
  const el = document.getElementById("cityMap");
  if (!el) return;
  if (!data.length) { el.innerHTML = "<p style='color:#5a6e5a'>Aucune donnée</p>"; return; }
  const maxCount = Math.max(...data.map(d => d.count), 1);
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(280px, 1fr));gap:8px;">
      ${data.map(d => {
        const w = (d.count / maxCount * 100).toFixed(0);
        const ecartColor = d.avgEcart < -10 ? "#00ff41" : d.avgEcart < 0 ? "#00aaff" : d.avgEcart < 10 ? "#ffaa00" : "#ff3333";
        return `
          <div style="background:#0d120d;border:1px solid #1a2e1a;border-radius:4px;padding:8px 10px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
              <span style="font-size:12px;font-weight:bold;color:#d0e8d0;">${d.ville || d.city || d.name || "--"}</span>
              <span style="font-size:10px;color:#5a6e5a;">${d.codePostal || d.zipCode || ""}</span>
            </div>
            <div style="height:6px;background:#1a2e1a;border-radius:3px;margin-bottom:4px;">
              <div style="height:100%;width:${w}%;background:#00aaff;border-radius:3px;"></div>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:10px;color:#5a6e5a;">
              <span>${d.count} analyses</span>
              ${d.avgEcart != null ? `<span style="color:${ecartColor}">écart ${d.avgEcart > 0 ? "+" : ""}${d.avgEcart}%</span>` : ""}
              ${d.nbBonnesAffaires != null ? `<span style="color:#00ff41">${d.nbBonnesAffaires} ✓</span>` : ""}
              ${d.nbSurpaye != null ? `<span style="color:#ff3333">${d.nbSurpaye} ✗</span>` : ""}
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderAdemeHealth(data) {
  const el = document.getElementById("ademeHealth");
  if (!el) return;
  if (!data) { el.innerHTML = `<p style="color:#ff3333;">ADEME service inaccessible</p>`; return; }
  const h = data.health || {};
  const statusColor = h.status === "OPERATIONAL" ? "#00ff41" : h.status === "DISABLED" ? "#666" : "#ffaa00";
  el.innerHTML = `
    <div style="text-align:center;margin-bottom:12px;">
      <div style="font-size:32px;font-weight:bold;color:${statusColor};">● ${h.status || "UNKNOWN"}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:11px;">
      ${[
        { label: "HITS", value: fmt(data.totalHits), color: "#00ff41" },
        { label: "MISSES", value: fmt(data.totalMisses), color: "#ffaa00" },
        { label: "ERRORS", value: fmt(data.totalErrors), color: "#ff3333" },
        { label: "CACHE HITS", value: fmt(data.totalCacheHits), color: "#00aaff" },
        { label: "COUVERTURE", value: pct(data.coveragePercent), color: "#d0e8d0" },
        { label: "DURÉE MOY", value: data.avgDurationMs ? data.avgDurationMs + "ms" : "--", color: "#d0e8d0" },
      ].map(k => `
        <div style="background:#0d120d;padding:8px;border-radius:4px;border:1px solid #1a2e1a;">
          <div style="color:#5a6e5a;font-size:9px;letter-spacing:1px;">${k.label}</div>
          <div style="color:${k.color};font-size:18px;font-weight:bold;">${k.value}</div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderRecent(data) {
  const el = document.getElementById("recentTable");
  if (!el) return;
  if (!data.length) { el.innerHTML = "<p style='padding:12px;color:#5a6e5a'>Aucune entrée récente</p>"; return; }

  // Auto-detect columns from data keys
  const sample = data[0];
  const cols = detectColumns(sample);

  const headerCells = cols.map(c => `<th style="padding:6px 8px;text-align:${c.align};">${c.label}</th>`).join("");
  const rows = data.map(row => {
    const cells = cols.map(c => {
      const val = row[c.key];
      let display = "--";
      let style = `padding:5px 8px;font-size:11px;text-align:${c.align};`;

      if (c.type === "time" && val) {
        display = timeSince(new Date(val));
        style += "color:#5a6e5a;font-size:10px;white-space:nowrap;";
      } else if (c.type === "currency" && val != null) {
        display = eur(val);
      } else if (c.type === "percent" && val != null) {
        const color = val < -10 ? "#00ff41" : val < 0 ? "#00aaff" : val < 10 ? "#ffaa00" : "#ff3333";
        display = (val > 0 ? "+" : "") + val.toFixed(1) + "%";
        style += `color:${color};`;
      } else if (c.type === "verdict" && val) {
        const color = VERDICT_COLORS[val] || "#666";
        display = val.replace(/_/g, " ");
        style += `color:${color};font-weight:bold;font-size:10px;`;
      } else if (c.type === "dpe" && val) {
        const color = DPE_COLORS[val] || "#666";
        return `<td style="${style}"><span style="display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;background:${color};color:#000;border-radius:3px;font-size:10px;font-weight:bold;">${val}</span></td>`;
      } else if (val != null) {
        display = typeof val === "number" ? fmt(val) : String(val);
      }
      return `<td style="${style}">${display}</td>`;
    }).join("");
    return `<tr style="border-bottom:1px solid #0d120d;">${cells}</tr>`;
  }).join("");

  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="border-bottom:1px solid #1a2e1a;color:#00ff41;font-size:9px;letter-spacing:1px;">${headerCells}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ── Auto-detect table columns from data shape ───────────────────────────────
function detectColumns(sample) {
  if (!sample) return [];
  const cols = [];
  const keyMap = {
    createdAt: { label: "QUAND", type: "time", align: "left" },
    updatedAt: { label: "MAJ", type: "time", align: "left" },
    ville: { label: "VILLE", type: "text", align: "left" },
    city: { label: "VILLE", type: "text", align: "left" },
    type: { label: "TYPE", type: "text", align: "left" },
    surface: { label: "SURFACE", type: "number", align: "right" },
    prix: { label: "PRIX", type: "currency", align: "right" },
    price: { label: "PRIX", type: "currency", align: "right" },
    prixM2: { label: "€/M²", type: "currency", align: "right" },
    ecartDvf: { label: "ÉCART", type: "percent", align: "right" },
    verdict: { label: "VERDICT", type: "verdict", align: "center" },
    dpe: { label: "DPE", type: "dpe", align: "center" },
    nbAgents: { label: "AGENTS", type: "number", align: "right" },
    rendementBrut: { label: "REND.", type: "percent", align: "right" },
    title: { label: "TITRE", type: "text", align: "left" },
    name: { label: "NOM", type: "text", align: "left" },
    status: { label: "STATUT", type: "text", align: "center" },
    score: { label: "SCORE", type: "number", align: "right" },
    category: { label: "CATÉGORIE", type: "text", align: "left" },
    count: { label: "TOTAL", type: "number", align: "right" },
  };

  for (const key of Object.keys(sample)) {
    if (key === "id" || key === "_id") continue;
    const mapped = keyMap[key];
    if (mapped) {
      cols.push({ key, ...mapped });
    } else if (typeof sample[key] === "string" && !key.endsWith("Id")) {
      cols.push({ key, label: key.toUpperCase(), type: "text", align: "left" });
    } else if (typeof sample[key] === "number") {
      cols.push({ key, label: key.toUpperCase(), type: "number", align: "right" });
    }
  }
  return cols.slice(0, 12); // Max 12 columns
}

// ============================================================================
// BOOT
// ============================================================================
boot();
