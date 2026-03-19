// ============================================================================
// SITREP — Target Configuration
// ============================================================================
// Each target is a production asset to monitor.
// Groups: ALERT-IMMO, EXAM-DRILL, CAPIPILOT, IMPACTDROIT, FRONTEND, INFRA
//
// Anti-ClickOps: Targets can be overridden via SITREP_TARGETS_FILE env var
// pointing to a JSON file (e.g., mounted ConfigMap in K8s).
//
// Target types:
//   - "spring-boot"  → expects JSON with { status: "UP" }
//   - "vercel"       → HTTP 200 = UP
//   - "web"          → HTTP 200 = UP
//   - "composite"    → aggregated health from /api/system/health
//                       returns { status, components: { id: { status, latencyMs } } }
//   - "grafana"      → HTTP 200 = UP
//   - "uptime-kuma"  → HTTP 200 = UP
// ============================================================================

const fs = require("fs");
const path = require("path");
const log = require("./lib/logger");

// ============================================================================
// APPS — Multi-Application Business Dashboard Registry
// ============================================================================
// Each app declares its backend URL and which dashboard endpoints it exposes.
// Apps without a dashboard config will show a placeholder with health status.
//
// Override via SITREP_APPS_FILE env var (JSON, same format).
// ============================================================================

const externalAppsPath = process.env.SITREP_APPS_FILE;
let APPS;

if (externalAppsPath && fs.existsSync(externalAppsPath)) {
  try {
    APPS = JSON.parse(fs.readFileSync(externalAppsPath, "utf8"));
    log.info({ count: APPS.length, file: externalAppsPath }, "Apps loaded from external file");
  } catch (err) {
    log.fatal({ err: err.message, file: externalAppsPath }, "Failed to load external apps config");
    process.exit(1);
  }
} else {
  APPS = [
    {
      id: "alert-immo",
      name: "Alert-Immo",
      icon: "🏠",
      group: "ALERT-IMMO",
      description: "Analyse immobilière — enrichissement DVF, DPE, agents IA",
      backendUrl: process.env.ALERTIMMO_BACKEND_URL || "https://api.real-estate-analytics.com",
      dashboard: {
        endpoints: ["overview", "quality", "by-verdict", "by-dpe", "agents", "timeline", "by-city", "recent"],
        ademe: true,
        widgets: ["kpis", "quality", "verdicts", "dpe", "timeline", "ademe", "agents", "cities", "recent"],
      },
    },
    {
      id: "impactdroit",
      name: "ImpactDroit",
      icon: "⚖️",
      group: "IMPACTDROIT",
      description: "Analyse juridique — impact législatif, veille réglementaire",
      backendUrl: process.env.IMPACTDROIT_BACKEND_URL || "https://api.impactdroit.com",
      dashboard: {
        endpoints: ["overview", "recent"],
        widgets: ["kpis", "recent"],
      },
    },
    {
      id: "exam-drill",
      name: "Exam Drill",
      icon: "📝",
      group: "EXAM-DRILL",
      description: "Préparation examens — génération et suivi de quiz",
      backendUrl: process.env.EXAMDRILL_BACKEND_URL || "https://exam-drill.delpech.dev",
      dashboard: null,
    },
    {
      id: "capipilot",
      name: "Capipilot",
      icon: "✈️",
      group: "CAPIPILOT",
      description: "Pilotage financier — analyse de capital et investissements",
      backendUrl: process.env.CAPIPILOT_BACKEND_URL || "https://api.capilot.app",
      dashboard: null,
    },
    {
      id: "rent-apply",
      name: "RentApply",
      icon: "🏢",
      group: "RENT-APPLY",
      description: "Dossier de candidature locative — Genève",
      backendUrl: process.env.RENTAPPLY_BACKEND_URL || "https://rent-apply.delpech.dev",
      dashboard: null,
    },
  ];
}

// ============================================================================
// TARGETS — Health Monitoring Targets
// ============================================================================

// Allow external config file override (K8s ConfigMap, Docker volume mount)
const externalConfigPath = process.env.SITREP_TARGETS_FILE;
let TARGETS;

if (externalConfigPath && fs.existsSync(externalConfigPath)) {
  try {
    TARGETS = JSON.parse(fs.readFileSync(externalConfigPath, "utf8"));
    log.info({ count: TARGETS.length, file: externalConfigPath }, "Targets loaded from external file");
  } catch (err) {
    log.fatal({ err: err.message, file: externalConfigPath }, "Failed to load external targets");
    process.exit(1);
  }
} else {
  // Default embedded targets — EDIT HERE or override via SITREP_TARGETS_FILE
  TARGETS = [
  // ── ALERT-IMMO ──────────────────────────────────────────────────────────
  {
    id: "alert-immo-gateway",
    name: "Gateway API",
    group: "ALERT-IMMO",
    type: "spring-boot",
    icon: "🚪",
    url: "https://api.real-estate-analytics.com/actuator/health",
    timeout: 10000,
  },
  // Composite health: probes ALL internal backends via the Gateway's /api/system/health
  // (requires gateway redeploy with SystemHealthController)
  {
    id: "alert-immo-system",
    name: "Backends Health",
    group: "ALERT-IMMO",
    type: "composite",
    icon: "🏠",
    url: "https://api.real-estate-analytics.com/api/system/health",
    timeout: 15000,
  },
  {
    id: "alert-immo-frontend",
    name: "Frontend",
    group: "ALERT-IMMO",
    type: "web",
    icon: "🖥️",
    url: "https://www.real-estate-analytics.com",
    timeout: 10000,
  },

  // ── ALERT-IMMO STAGING ────────────────────────────────────────────────────
  {
    id: "alert-immo-staging-gateway",
    name: "Staging Gateway",
    group: "ALERT-IMMO-STAGING",
    type: "spring-boot",
    icon: "🧪",
    url: process.env.ALERTIMMO_STAGING_URL || "https://staging-api.real-estate-analytics.com/actuator/health",
    timeout: 10000,
  },
  {
    id: "alert-immo-staging-system",
    name: "Staging Backends",
    group: "ALERT-IMMO-STAGING",
    type: "composite",
    icon: "🧪",
    url: process.env.ALERTIMMO_STAGING_URL
      ? `${process.env.ALERTIMMO_STAGING_URL.replace(/\/actuator\/health$/, "")}/api/system/health`
      : "https://staging-api.real-estate-analytics.com/api/system/health",
    timeout: 15000,
  },

  // ── EXAM-DRILL ──────────────────────────────────────────────────────────
  {
    id: "exam-drill-api",
    name: "Exam Drill API",
    group: "EXAM-DRILL",
    type: "spring-boot",
    icon: "📝",
    url: "https://exam-drill.delpech.dev/actuator/health",
    timeout: 10000,
  },

  // ── CAPIPILOT ───────────────────────────────────────────────────────────
  {
    id: "capipilot-api",
    name: "Capipilot API",
    group: "CAPIPILOT",
    type: "spring-boot",
    icon: "✈️",
    url: "https://api.capilot.app/actuator/health",
    timeout: 10000,
  },

  // ── IMPACTDROIT ─────────────────────────────────────────────────────────
  {
    id: "impactdroit-api",
    name: "ImpactDroit API",
    group: "IMPACTDROIT",
    type: "spring-boot",
    icon: "⚖️",
    url: "https://api.impactdroit.com/actuator/health",
    timeout: 10000,
  },
  {
    id: "impactdroit-analyzer",
    name: "Legal Analyzer",
    group: "IMPACTDROIT",
    type: "spring-boot",
    icon: "🔍",
    url: "https://analyzer.impactdroit.com/api/v1/health",
    timeout: 10000,
  },
  {
    id: "impactdroit-frontend",
    name: "ImpactDroit Web",
    group: "IMPACTDROIT",
    type: "web",
    icon: "⚖️",
    url: "https://www.impactdroit.com",
    timeout: 10000,
  },
  // status.impactdroit.com — Uptime Kuma not deployed yet, no DNS record
  // Re-add when deployed: { id: "impactdroit-status", url: "https://status.impactdroit.com", type: "uptime-kuma" }

  // ── FRONTENDS ───────────────────────────────────────────────────────────
  {
    id: "rent-apply-web",
    name: "Rent Apply Web",
    group: "RENT-APPLY",
    type: "web",
    icon: "🏢",
    url: "https://rent-apply.delpech.dev",
    timeout: 10000,
  },
  {
    id: "rent-apply-health",
    name: "Rent Apply API",
    group: "RENT-APPLY",
    type: "composite",
    icon: "🏠",
    url: "https://rent-apply.delpech.dev/api/health",
    timeout: 10000,
  },
  // benjamindelpech.dev — DNS not configured yet
  // Re-add when deployed: { id: "portfolio", url: "https://benjamindelpech.dev", type: "web" }

  // ── INFRA ───────────────────────────────────────────────────────────────
  {
    id: "auth0-tenant",
    name: "Auth0 Tenant",
    group: "INFRA",
    type: "web",
    icon: "🔐",
    url: "https://dev-vns5q4ii3hb5gp6g.us.auth0.com/.well-known/openid-configuration",
    timeout: 8000,
  },
  {
    id: "grafana",
    name: "Grafana",
    group: "INFRA",
    type: "grafana",
    icon: "📈",
    url: "https://grafana.delpech.dev",
    timeout: 10000,
  },
  {
    id: "sitrep",
    name: "SITREP Dashboard",
    group: "INFRA",
    type: "web",
    icon: "🎯",
    url: "https://sitrep.delpech.dev/api/status",
    timeout: 10000,
  },
];
}

module.exports = { TARGETS, APPS };
