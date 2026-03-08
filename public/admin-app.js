// ============================================================================
// SITREP — Admin Enrichissement Dashboard
// ============================================================================
// Vanilla JS — zero dependencies. Military theme.
// Polls /api/admin/dashboard/* every 30s.
// ============================================================================

const REFRESH_MS = 30_000;

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

// ── Verdict colors ──────────────────────────────────────────────────────────
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

// ── LOAD ALL DATA ───────────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const [overview, quality, verdicts, dpe, agents, timeline, cities, ademe, recent] =
      await Promise.all([
        fetchJson("/api/admin/dashboard/overview"),
        fetchJson("/api/admin/dashboard/quality"),
        fetchJson("/api/admin/dashboard/by-verdict"),
        fetchJson("/api/admin/dashboard/by-dpe"),
        fetchJson("/api/admin/dashboard/agents"),
        fetchJson("/api/admin/dashboard/timeline"),
        fetchJson("/api/admin/dashboard/by-city"),
        fetchJson("/api/ademe/dashboard").catch(() => null),
        fetchJson("/api/admin/dashboard/recent"),
      ]);

    renderKPIs(overview, quality);
    renderQualityBreakdown(quality);
    renderVerdicts(verdicts);
    renderDpe(dpe);
    renderTimeline(timeline);
    renderAgents(agents, overview.total || 0);
    renderCityMap(cities);
    renderAdemeHealth(ademe);
    renderRecent(recent);
  } catch (err) {
    console.error("[ADMIN] Load failed:", err);
  }
}

// ── KPIs ────────────────────────────────────────────────────────────────────
function renderKPIs(ov, q) {
  setText("kpiTotal", fmt(ov.total));
  setText("kpi24h", fmt(ov.last24h));
  setText("kpi7d", fmt(ov.last7d));
  setText("kpiVilles", fmt(ov.nbVilles));
  setText("kpiScore", q.score != null ? q.score.toFixed(0) + "/100" : "--");
  setText("kpiAdeme", pct(ov.ademeEnrichedPercent));
  setText("kpiConfA", pct(ov.confidenceAPercent));
  setText("kpiRendement", ov.avgRendementBrut != null ? ov.avgRendementBrut.toFixed(1) + "%" : "--");

  // Color the score
  const scoreEl = document.getElementById("kpiScore");
  if (scoreEl && q.score != null) {
    scoreEl.style.color = q.score >= 80 ? "#00ff41" : q.score >= 50 ? "#ffaa00" : "#ff3333";
  }
}

// ── Quality Breakdown ───────────────────────────────────────────────────────
function renderQualityBreakdown(q) {
  const el = document.getElementById("qualityBreakdown");
  if (!q.breakdown) { el.innerHTML = "<p style='color:#ff3333'>Pas de données</p>"; return; }

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

// ── Verdicts ────────────────────────────────────────────────────────────────
function renderVerdicts(data) {
  const el = document.getElementById("verdictChart");
  if (!data.length) { el.innerHTML = "<p style='color:#5a6e5a'>Aucune donnée</p>"; return; }

  const total = data.reduce((s, d) => s + d.count, 0);
  el.innerHTML = data.map(d => {
    const color = VERDICT_COLORS[d.verdict] || "#666";
    const w = (d.count / total * 100).toFixed(1);
    return `
      <div style="margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px;">
          <span style="color:${color}">● ${d.verdict.replace(/_/g, " ")}</span>
          <span>${d.count} (${w}%) — écart moy. ${d.avgEcart > 0 ? "+" : ""}${d.avgEcart}%</span>
        </div>
        <div style="height:6px;background:#1a2e1a;border-radius:3px;overflow:hidden;">
          <div style="height:100%;width:${w}%;background:${color};border-radius:3px;"></div>
        </div>
      </div>
    `;
  }).join("");
}

// ── DPE ─────────────────────────────────────────────────────────────────────
function renderDpe(data) {
  const el = document.getElementById("dpeChart");
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

// ── Timeline Canvas ─────────────────────────────────────────────────────────
function renderTimeline(data) {
  const canvas = document.getElementById("timelineCanvas");
  if (!data.length || !canvas) return;

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = 180 * dpr;
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = 180;
  const pad = { top: 20, right: 16, bottom: 30, left: 40 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const maxCount = Math.max(...data.map(d => d.count), 1);
  const barW = Math.max(plotW / data.length - 2, 4);

  // Background
  ctx.fillStyle = "#0d120d";
  ctx.fillRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = "#1a2e1a";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (plotH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();

    ctx.fillStyle = "#5a6e5a";
    ctx.font = "9px monospace";
    ctx.textAlign = "right";
    ctx.fillText(Math.round(maxCount * (1 - i / 4)).toString(), pad.left - 4, y + 3);
  }

  // Bars
  data.forEach((d, i) => {
    const x = pad.left + (plotW / data.length) * i + 1;
    const h = (d.count / maxCount) * plotH;
    const y = pad.top + plotH - h;

    // Stacked: bonnes (green) + surpaye (red) + rest (blue)
    const rest = d.count - (d.bonnesAffaires || 0) - (d.surpaye || 0);
    const hBonne = ((d.bonnesAffaires || 0) / maxCount) * plotH;
    const hSurpaye = ((d.surpaye || 0) / maxCount) * plotH;
    const hRest = (rest / maxCount) * plotH;

    let cy = pad.top + plotH;

    ctx.fillStyle = "#00ff4180";
    ctx.fillRect(x, cy - hBonne, barW, hBonne);
    cy -= hBonne;

    ctx.fillStyle = "#00aaff60";
    ctx.fillRect(x, cy - hRest, barW, hRest);
    cy -= hRest;

    ctx.fillStyle = "#ff333380";
    ctx.fillRect(x, cy - hSurpaye, barW, hSurpaye);

    // X label (every 5 days)
    if (i % 5 === 0 || i === data.length - 1) {
      ctx.fillStyle = "#5a6e5a";
      ctx.font = "8px monospace";
      ctx.textAlign = "center";
      const label = d.date.substring(5); // MM-DD
      ctx.fillText(label, x + barW / 2, H - pad.bottom + 14);
    }
  });

  // Legend
  ctx.font = "9px monospace";
  const legends = [
    { color: "#00ff41", label: "BONNE AFFAIRE" },
    { color: "#00aaff", label: "AUTRES" },
    { color: "#ff3333", label: "SURPAYÉ" },
  ];
  let lx = pad.left;
  legends.forEach(l => {
    ctx.fillStyle = l.color;
    ctx.fillRect(lx, 4, 10, 10);
    ctx.fillStyle = "#b0c4b0";
    ctx.fillText(l.label, lx + 14, 13);
    lx += ctx.measureText(l.label).width + 28;
  });
}

// ── Agents Table ────────────────────────────────────────────────────────────
function renderAgents(data, totalAnalyses) {
  const el = document.getElementById("agentsTable");
  if (!data.length) { el.innerHTML = "<p style='padding:12px;color:#5a6e5a'>Aucun agent activé</p>"; return; }

  const rows = data.map(a => {
    const coveragePct = totalAnalyses > 0 ? (a.activations / totalAnalyses * 100).toFixed(1) : "0";
    const barColor = a.avgImpact >= 0 ? "#00ff41" : a.avgImpact >= -3 ? "#ffaa00" : "#ff3333";
    const confColor = a.dominantConfidence === "HIGH" ? "#00ff41" : a.dominantConfidence === "MEDIUM" ? "#ffaa00" : "#ff3333";

    return `<tr>
      <td style="padding:6px 10px;font-size:11px;white-space:nowrap;">${a.agentId}</td>
      <td style="padding:6px 10px;font-size:11px;">${a.agentName}</td>
      <td style="padding:6px 10px;text-align:right;">${a.activations}</td>
      <td style="padding:6px 10px;text-align:right;">${coveragePct}%</td>
      <td style="padding:6px 10px;text-align:right;color:${barColor}">${a.avgImpact > 0 ? "+" : ""}${a.avgImpact}%</td>
      <td style="padding:6px 10px;text-align:right;">[${a.minImpact}, ${a.maxImpact}]</td>
      <td style="padding:6px 10px;text-align:center;color:${confColor}">${a.dominantConfidence}</td>
    </tr>`;
  }).join("");

  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="border-bottom:1px solid #1a2e1a;color:#00ff41;font-size:10px;letter-spacing:1px;">
          <th style="padding:8px 10px;text-align:left;">AGENT ID</th>
          <th style="padding:8px 10px;text-align:left;">NOM</th>
          <th style="padding:8px 10px;text-align:right;">ACTIVATIONS</th>
          <th style="padding:8px 10px;text-align:right;">COUVERTURE</th>
          <th style="padding:8px 10px;text-align:right;">IMPACT MOY</th>
          <th style="padding:8px 10px;text-align:right;">RANGE</th>
          <th style="padding:8px 10px;text-align:center;">CONFIANCE</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ── City Map (bar chart by city) ────────────────────────────────────────────
function renderCityMap(data) {
  const el = document.getElementById("cityMap");
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
              <span style="font-size:12px;font-weight:bold;color:#d0e8d0;">${d.ville}</span>
              <span style="font-size:10px;color:#5a6e5a;">${d.codePostal}</span>
            </div>
            <div style="height:6px;background:#1a2e1a;border-radius:3px;margin-bottom:4px;">
              <div style="height:100%;width:${w}%;background:#00aaff;border-radius:3px;"></div>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:10px;color:#5a6e5a;">
              <span>${d.count} analyses</span>
              <span style="color:${ecartColor}">écart ${d.avgEcart > 0 ? "+" : ""}${d.avgEcart}%</span>
              <span style="color:#00ff41">${d.nbBonnesAffaires} ✓</span>
              <span style="color:#ff3333">${d.nbSurpaye} ✗</span>
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

// ── ADEME Health ────────────────────────────────────────────────────────────
function renderAdemeHealth(data) {
  const el = document.getElementById("ademeHealth");
  if (!data) {
    el.innerHTML = `<p style="color:#ff3333;">ADEME service inaccessible</p>`;
    return;
  }

  const h = data.health || {};
  const statusColor = h.status === "OPERATIONAL" ? "#00ff41" : h.status === "DISABLED" ? "#666" : "#ffaa00";

  el.innerHTML = `
    <div style="text-align:center;margin-bottom:12px;">
      <div style="font-size:32px;font-weight:bold;color:${statusColor};">● ${h.status || "UNKNOWN"}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:11px;">
      <div style="background:#0d120d;padding:8px;border-radius:4px;border:1px solid #1a2e1a;">
        <div style="color:#5a6e5a;font-size:9px;letter-spacing:1px;">HITS</div>
        <div style="color:#00ff41;font-size:18px;font-weight:bold;">${fmt(data.totalHits)}</div>
      </div>
      <div style="background:#0d120d;padding:8px;border-radius:4px;border:1px solid #1a2e1a;">
        <div style="color:#5a6e5a;font-size:9px;letter-spacing:1px;">MISSES</div>
        <div style="color:#ffaa00;font-size:18px;font-weight:bold;">${fmt(data.totalMisses)}</div>
      </div>
      <div style="background:#0d120d;padding:8px;border-radius:4px;border:1px solid #1a2e1a;">
        <div style="color:#5a6e5a;font-size:9px;letter-spacing:1px;">ERRORS</div>
        <div style="color:#ff3333;font-size:18px;font-weight:bold;">${fmt(data.totalErrors)}</div>
      </div>
      <div style="background:#0d120d;padding:8px;border-radius:4px;border:1px solid #1a2e1a;">
        <div style="color:#5a6e5a;font-size:9px;letter-spacing:1px;">CACHE HITS</div>
        <div style="color:#00aaff;font-size:18px;font-weight:bold;">${fmt(data.totalCacheHits)}</div>
      </div>
      <div style="background:#0d120d;padding:8px;border-radius:4px;border:1px solid #1a2e1a;">
        <div style="color:#5a6e5a;font-size:9px;letter-spacing:1px;">COUVERTURE</div>
        <div style="color:#d0e8d0;font-size:18px;font-weight:bold;">${pct(data.coveragePercent)}</div>
      </div>
      <div style="background:#0d120d;padding:8px;border-radius:4px;border:1px solid #1a2e1a;">
        <div style="color:#5a6e5a;font-size:9px;letter-spacing:1px;">DURÉE MOY</div>
        <div style="color:#d0e8d0;font-size:18px;font-weight:bold;">${data.avgDurationMs ? data.avgDurationMs + "ms" : "--"}</div>
      </div>
    </div>
  `;
}

// ── Recent Analyses Table ───────────────────────────────────────────────────
function renderRecent(data) {
  const el = document.getElementById("recentTable");
  if (!data.length) { el.innerHTML = "<p style='padding:12px;color:#5a6e5a'>Aucune analyse</p>"; return; }

  const rows = data.map(a => {
    const verdictColor = VERDICT_COLORS[a.verdict] || "#666";
    const dpeColor = DPE_COLORS[a.dpe] || "#666";
    const ecartColor = (a.ecartDvf || 0) < -10 ? "#00ff41" : (a.ecartDvf || 0) < 0 ? "#00aaff" : (a.ecartDvf || 0) < 10 ? "#ffaa00" : "#ff3333";
    const timeAgo = a.createdAt ? timeSince(new Date(a.createdAt)) : "--";

    return `<tr style="border-bottom:1px solid #0d120d;">
      <td style="padding:5px 8px;font-size:10px;color:#5a6e5a;white-space:nowrap;">${timeAgo}</td>
      <td style="padding:5px 8px;font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${a.ville || "--"}</td>
      <td style="padding:5px 8px;font-size:11px;">${a.type || "--"}</td>
      <td style="padding:5px 8px;text-align:right;">${a.surface || "--"}m²</td>
      <td style="padding:5px 8px;text-align:right;">${eur(a.prix)}</td>
      <td style="padding:5px 8px;text-align:right;">${a.prixM2 ? eur(a.prixM2) + "/m²" : "--"}</td>
      <td style="padding:5px 8px;text-align:right;color:${ecartColor}">${a.ecartDvf != null ? (a.ecartDvf > 0 ? "+" : "") + a.ecartDvf.toFixed(1) + "%" : "--"}</td>
      <td style="padding:5px 8px;text-align:center;color:${verdictColor};font-weight:bold;font-size:10px;">${(a.verdict || "--").replace(/_/g, " ")}</td>
      <td style="padding:5px 8px;text-align:center;"><span style="display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;background:${dpeColor};color:#000;border-radius:3px;font-size:10px;font-weight:bold;">${a.dpe || "?"}</span></td>
      <td style="padding:5px 8px;text-align:right;">${a.nbAgents || 0}</td>
      <td style="padding:5px 8px;text-align:right;">${a.rendementBrut ? a.rendementBrut.toFixed(1) + "%" : "--"}</td>
    </tr>`;
  }).join("");

  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="border-bottom:1px solid #1a2e1a;color:#00ff41;font-size:9px;letter-spacing:1px;">
          <th style="padding:6px 8px;text-align:left;">QUAND</th>
          <th style="padding:6px 8px;text-align:left;">VILLE</th>
          <th style="padding:6px 8px;text-align:left;">TYPE</th>
          <th style="padding:6px 8px;text-align:right;">SURFACE</th>
          <th style="padding:6px 8px;text-align:right;">PRIX</th>
          <th style="padding:6px 8px;text-align:right;">€/M²</th>
          <th style="padding:6px 8px;text-align:right;">ÉCART DVF</th>
          <th style="padding:6px 8px;text-align:center;">VERDICT</th>
          <th style="padding:6px 8px;text-align:center;">DPE</th>
          <th style="padding:6px 8px;text-align:right;">AGENTS</th>
          <th style="padding:6px 8px;text-align:right;">REND.</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ── Utils ────────────────────────────────────────────────────────────────────
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function timeSince(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "min";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h";
  const days = Math.floor(hours / 24);
  return days + "j";
}

// ── Boot ────────────────────────────────────────────────────────────────────
loadDashboard();
setInterval(loadDashboard, REFRESH_MS);
