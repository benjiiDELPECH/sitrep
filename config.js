// ============================================================================
// SITREP — Target Configuration
// ============================================================================
// Each target is a production asset to monitor.
// Groups: ALERT-IMMO, EXAM-DRILL, CAPIPILOT, IMPACTDROIT, FRONTEND, INFRA
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

const TARGETS = [
  // ── ALERT-IMMO ──────────────────────────────────────────────────────────
  // Composite health: probes ALL internal backends via the Gateway's /api/system/health
  {
    id: "alert-immo-system",
    name: "Alert-Immo Platform",
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
    type: "vercel",
    icon: "🖥️",
    url: "https://www.real-estate-analytics.com",
    timeout: 10000,
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
  {
    id: "impactdroit-status",
    name: "Status Page",
    group: "IMPACTDROIT",
    type: "uptime-kuma",
    icon: "📊",
    url: "https://status.impactdroit.com",
    timeout: 10000,
  },

  // ── FRONTENDS (Vercel) ──────────────────────────────────────────────────
  {
    id: "rent-apply",
    name: "Rent Apply",
    group: "FRONTENDS",
    type: "vercel",
    icon: "🏢",
    url: "https://rent-apply.vercel.app",
    timeout: 10000,
  },
  {
    id: "portfolio",
    name: "Portfolio",
    group: "FRONTENDS",
    type: "vercel",
    icon: "👤",
    url: "https://benjamindelpech.dev",
    timeout: 10000,
  },

  // ── INFRA ───────────────────────────────────────────────────────────────
  {
    id: "grafana",
    name: "Grafana",
    group: "INFRA",
    type: "grafana",
    icon: "📈",
    url: "https://grafana.delpech.dev",
    timeout: 10000,
  },
];

module.exports = { TARGETS };
