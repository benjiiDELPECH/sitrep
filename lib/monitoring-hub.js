// ============================================================================
// SITREP — Monitoring Hub (Central Aggregation)
// ============================================================================
// Orchestrates all collectors and exposes a unified API.
// Modules: GitHub, Code Intelligence, Finance, Notion, Infra Health (built-in)
// ============================================================================

const log = require("./logger");

// Lazy-load collectors (they may have optional dependencies)
let github, codeIntel, finance, notionSync;

try { github = require("./collectors/github"); } catch (e) {
  log.warn({ err: e.message }, "GitHub collector not available");
}
try { codeIntel = require("./collectors/code-intelligence"); } catch (e) {
  log.warn({ err: e.message }, "Code Intelligence collector not available");
}
try { finance = require("./collectors/finance"); } catch (e) {
  log.warn({ err: e.message }, "Finance collector not available");
}
try { notionSync = require("./collectors/notion-sync"); } catch (e) {
  log.warn({ err: e.message }, "Notion sync collector not available");
}

const collectors = [
  { name: "github",            module: github,    enabled: false, timer: null },
  { name: "code-intelligence", module: codeIntel, enabled: false, timer: null },
  { name: "finance",           module: finance,   enabled: false, timer: null },
  { name: "notion-sync",       module: notionSync,enabled: false, timer: null },
];

// ── Initialize & Start Collectors ───────────────────────────────────────────
async function start() {
  log.info("Monitoring Hub: starting collectors");

  for (const c of collectors) {
    if (!c.module) continue;
    try {
      await c.module.refreshAll();
      c.enabled = true;
      c.timer = setInterval(() => {
        c.module.refreshAll().catch((err) => {
          log.error({ err: err.message, collector: c.name }, "Collector refresh failed");
        });
      }, c.module.REFRESH_INTERVAL);
      log.info({ collector: c.name, interval: c.module.REFRESH_INTERVAL }, "Collector started");
    } catch (err) {
      log.warn({ err: err.message, collector: c.name }, "Collector failed to start — skipping");
    }
  }

  const enabled = collectors.filter((c) => c.enabled).map((c) => c.name);
  log.info({ enabled, count: enabled.length }, "Monitoring Hub: collectors started");
}

// ── Stop ────────────────────────────────────────────────────────────────────
async function stop() {
  for (const c of collectors) {
    if (c.timer) clearInterval(c.timer);
    if (c.module?.shutdown) await c.module.shutdown();
  }
  log.info("Monitoring Hub: stopped");
}

// ── Unified Dashboard Summary ───────────────────────────────────────────────
function getDashboard() {
  const modules = {};

  if (github?.getSummary) {
    modules.github = github.getSummary();
  }
  if (codeIntel?.getSummary) {
    modules.codeIntelligence = codeIntel.getSummary();
  }
  if (finance?.getSummary) {
    modules.finance = finance.getSummary();
  }
  if (notionSync?.getSummary) {
    modules.notion = notionSync.getSummary();
  }

  // Cross-module health score
  const healthFactors = [];

  // GitHub CI health
  if (modules.github?.summary?.ciHealthPct != null) {
    healthFactors.push({ name: "CI/CD Health", score: modules.github.summary.ciHealthPct, weight: 3 });
  }

  // Code quality health
  if (modules.codeIntelligence?.aggregate?.avgHealthScore != null) {
    healthFactors.push({ name: "Code Quality", score: modules.codeIntelligence.aggregate.avgHealthScore, weight: 2 });
  }

  // Budget health
  if (modules.finance?.budgetUsagePct != null) {
    const budgetHealth = modules.finance.budgetUsagePct > 100
      ? Math.max(0, 100 - (modules.finance.budgetUsagePct - 100) * 2)
      : 100;
    healthFactors.push({ name: "Budget", score: budgetHealth, weight: 1 });
  }

  // Roadmap velocity (items completed vs overdue)
  if (modules.notion?.roadmap?.analytics) {
    const { velocity7d, overdue, total } = modules.notion.roadmap.analytics;
    const roadmapHealth = total > 0
      ? Math.min(100, Math.round(((velocity7d * 10) / Math.max(overdue, 1)) * 20))
      : 50;
    healthFactors.push({ name: "Roadmap Velocity", score: roadmapHealth, weight: 1 });
  }

  const totalWeight = healthFactors.reduce((s, f) => s + f.weight, 0);
  const overallHealth = totalWeight > 0
    ? Math.round(healthFactors.reduce((s, f) => s + f.score * f.weight, 0) / totalWeight)
    : null;

  return {
    overallHealth,
    healthFactors,
    enabledModules: collectors.filter((c) => c.enabled).map((c) => c.name),
    disabledModules: collectors.filter((c) => !c.enabled).map((c) => c.name),
    modules,
    timestamp: new Date().toISOString(),
  };
}

// ── Per-Project Unified View ────────────────────────────────────────────────
function getProjectView(projectName) {
  const view = { project: projectName };

  // Map project name to repo name (they may differ)
  const repoMapping = {
    "alert-immo": "alert-immo",
    "exam-drilling": "exam-drilling",
    "exam-drill": "exam-drilling",
    "rent-apply": "rent-apply",
    "smartresume": "smartresume",
    "portfolio": "portfolio",
    "sitrep": "sitrep",
    "delpech-infra": "delpech-infra",
    "delpech-toolskit": "delpech-toolskit",
  };

  const repoName = repoMapping[projectName] || projectName;

  if (github?.getRepoDetail) {
    view.github = github.getRepoDetail(repoName);
  }
  if (codeIntel?.getProjectDetail) {
    view.codeIntelligence = codeIntel.getProjectDetail(projectName);
  }
  if (finance?.getSummary) {
    const fin = finance.getSummary();
    view.monthlyCost = fin?.costPerProject?.[projectName] || 0;
  }
  if (notionSync?.getSummary) {
    const notion = notionSync.getSummary();
    view.roadmapItems = (notion?.roadmap?.items || []).filter(
      (i) => (i.project || "").toLowerCase().includes(projectName.toLowerCase())
    );
  }

  return view;
}

module.exports = {
  start,
  stop,
  getDashboard,
  getProjectView,
};
