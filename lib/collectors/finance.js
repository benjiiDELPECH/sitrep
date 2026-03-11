// ============================================================================
// SITREP — Finance / Budget Collector
// ============================================================================
// Tracks infrastructure costs per provider and per project.
// Sources: manual config + Hetzner API + Vercel API (when tokens available)
//
// Anti-ClickOps: Override via SITREP_FINANCE_FILE env var (JSON).
// ============================================================================

const fs = require("fs");
const log = require("../logger");

const HETZNER_TOKEN = process.env.HETZNER_API_TOKEN || null;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN || null;

// ── Default budget configuration (edit or override via env) ─────────────────
const externalFinancePath = process.env.SITREP_FINANCE_FILE;
let BUDGET_CONFIG;

if (externalFinancePath && fs.existsSync(externalFinancePath)) {
  try {
    BUDGET_CONFIG = JSON.parse(fs.readFileSync(externalFinancePath, "utf8"));
    log.info({ file: externalFinancePath }, "Finance config loaded from external file");
  } catch (err) {
    log.error({ err: err.message }, "Failed to load finance config");
  }
}

if (!BUDGET_CONFIG) {
  BUDGET_CONFIG = {
    currency: "EUR",
    monthlyBudget: 50, // Target: max 50€/month for all infra
    providers: [
      {
        id: "hetzner",
        name: "Hetzner Cloud",
        icon: "☁️",
        type: "compute",
        monthlyCost: 15.90,  // CX22 + volumes
        services: [
          { name: "CX22 (K3s Node)", cost: 5.39 },
          { name: "CX22 (K3s Node 2)", cost: 5.39 },
          { name: "Volumes (20GB)", cost: 0.96 },
          { name: "Load Balancer LB11", cost: 4.16 },
        ],
        projects: ["alert-immo", "exam-drilling", "impactdroit", "sitrep", "grafana"],
      },
      {
        id: "cloudflare",
        name: "Cloudflare",
        icon: "🌐",
        type: "dns+cdn",
        monthlyCost: 0,      // Free tier
        services: [
          { name: "DNS (free)", cost: 0 },
          { name: "CDN/DDoS (free)", cost: 0 },
        ],
        projects: ["all"],
      },
      {
        id: "vercel",
        name: "Vercel",
        icon: "▲",
        type: "hosting",
        monthlyCost: 0,      // Hobby (free)
        services: [
          { name: "Hobby plan (free)", cost: 0 },
        ],
        projects: ["rent-apply", "portfolio"],
      },
      {
        id: "firebase",
        name: "Firebase / GCP",
        icon: "🔥",
        type: "baas",
        monthlyCost: 0,      // Spark plan (free)
        services: [
          { name: "Spark plan (free)", cost: 0 },
        ],
        projects: ["capipilot"],
      },
      {
        id: "github",
        name: "GitHub",
        icon: "🐙",
        type: "scm+ci",
        monthlyCost: 0,      // Free for public repos
        services: [
          { name: "Free tier", cost: 0 },
          { name: "Actions (2000 min/mo)", cost: 0 },
        ],
        projects: ["all"],
      },
      {
        id: "letsencrypt",
        name: "Let's Encrypt",
        icon: "🔒",
        type: "ssl",
        monthlyCost: 0,
        services: [{ name: "SSL Certs (free)", cost: 0 }],
        projects: ["all"],
      },
      {
        id: "discord",
        name: "Discord",
        icon: "💬",
        type: "alerts",
        monthlyCost: 0,
        services: [{ name: "Webhooks (free)", cost: 0 }],
        projects: ["sitrep"],
      },
    ],
    costHistory: [], // { month: "2026-03", total: 15.90, breakdown: {...} }
  };
}

const cache = {
  budget: null,
  hetznerLive: null,
  lastRefresh: null,
};

const REFRESH_INTERVAL = 30 * 60 * 1000; // 30 min

// ── Hetzner API (live costs) ────────────────────────────────────────────────
async function fetchHetznerCosts() {
  if (!HETZNER_TOKEN) return null;

  try {
    const res = await fetch("https://api.hetzner.cloud/v1/servers", {
      headers: {
        "Authorization": `Bearer ${HETZNER_TOKEN}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      log.warn({ status: res.status }, "Hetzner API failed");
      return null;
    }

    const data = await res.json();
    const servers = (data.servers || []).map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      serverType: s.server_type?.name,
      datacenter: s.datacenter?.name,
      ip: s.public_net?.ipv4?.ip,
      monthlyCost: s.server_type?.prices?.[0]?.price_monthly?.gross
        ? parseFloat(s.server_type.prices[0].price_monthly.gross)
        : null,
      created: s.created,
    }));

    const totalMonthlyCost = servers.reduce((s, srv) => s + (srv.monthlyCost || 0), 0);

    return { servers, totalMonthlyCost, fetchedAt: new Date().toISOString() };
  } catch (err) {
    log.error({ err: err.message }, "Hetzner cost fetch failed");
    return null;
  }
}

// ── Full Refresh ────────────────────────────────────────────────────────────
async function refreshAll() {
  log.info("Finance collector: refreshing");

  const hetzner = await fetchHetznerCosts();
  if (hetzner) cache.hetznerLive = hetzner;

  // Compute totals
  const totalMonthly = BUDGET_CONFIG.providers.reduce((s, p) => s + p.monthlyCost, 0);
  const totalAnnual = totalMonthly * 12;
  const budgetUsage = BUDGET_CONFIG.monthlyBudget > 0
    ? Math.round((totalMonthly / BUDGET_CONFIG.monthlyBudget) * 100)
    : 0;

  // Cost per project (approximate allocation)
  const costPerProject = {};
  for (const provider of BUDGET_CONFIG.providers) {
    for (const proj of provider.projects) {
      if (proj === "all") continue; // skip "all" allocation
      const share = provider.monthlyCost / provider.projects.filter((p) => p !== "all").length;
      costPerProject[proj] = (costPerProject[proj] || 0) + share;
    }
  }

  cache.budget = {
    currency: BUDGET_CONFIG.currency,
    monthlyBudget: BUDGET_CONFIG.monthlyBudget,
    totalMonthly,
    totalAnnual,
    budgetUsagePct: budgetUsage,
    budgetStatus: budgetUsage > 100 ? "OVER_BUDGET" : budgetUsage > 80 ? "WARNING" : "OK",
    providers: BUDGET_CONFIG.providers,
    costPerProject,
    hetznerLive: cache.hetznerLive,
  };

  cache.lastRefresh = new Date().toISOString();
  log.info({
    totalMonthly,
    budgetUsage: `${budgetUsage}%`,
    providers: BUDGET_CONFIG.providers.length,
  }, "Finance collector: refresh complete");
}

function getSummary() {
  return {
    ...cache.budget,
    lastRefresh: cache.lastRefresh,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  refreshAll,
  getSummary,
  REFRESH_INTERVAL,
};
