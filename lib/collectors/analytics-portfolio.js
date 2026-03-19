// ============================================================================
// SITREP — Analytics Portfolio Collector
// ============================================================================
// Consumes the delpech-user-behavior-analytics server endpoints to display
// per-project behavioral KPIs: activation rate, conversion rate, decision,
// confidence, top events, and funnel dropoffs.
//
// Source: analytics-server-spring (Spring Boot starter)
// Endpoints polled:
//   GET /api/events/analysis/{projectId}?days=30
//   GET /api/events/advice/{projectId}?days=30
//
// Configure via ANALYTICS_API_URL env var (default: http://localhost:8080)
// ============================================================================

const log = require("../logger");

const ANALYTICS_API_URL = (
  process.env.ANALYTICS_API_URL || "http://localhost:8080"
).replace(/\/+$/, "");

const ANALYTICS_API_KEY = process.env.ANALYTICS_API_KEY || "";

const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 min

// Projects to poll - must match projectId used when ingesting events
const TRACKED_PROJECTS = (
  process.env.ANALYTICS_PROJECTS || "alert-immo,exam-drill,impactdroit,capipilot,rent-apply"
).split(",").map((s) => s.trim()).filter(Boolean);

// -- Cache --
const cache = {
  projects: {},
  lastRefresh: null,
  error: null,
};

// -- HTTP helper --
async function fetchJson(url) {
  const headers = { "Accept": "application/json" };
  if (ANALYTICS_API_KEY) {
    headers["X-Api-Key"] = ANALYTICS_API_KEY;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    log.warn({ err: err.message, url }, "Analytics fetch failed");
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// -- Fetch one project --
async function fetchProject(projectId) {
  const basePath = ANALYTICS_API_URL + "/api/events";

  const [analysis, advice] = await Promise.all([
    fetchJson(basePath + "/analysis/" + projectId + "?days=30"),
    fetchJson(basePath + "/advice/" + projectId + "?days=30"),
  ]);

  return { analysis, advice, fetchedAt: new Date().toISOString() };
}

// -- Full Refresh --
async function refreshAll() {
  log.info({ projects: TRACKED_PROJECTS }, "Analytics Portfolio collector: refreshing");

  const results = await Promise.allSettled(
    TRACKED_PROJECTS.map(async (projectId) => {
      const data = await fetchProject(projectId);
      cache.projects[projectId] = data;
      return { projectId, hasData: !!(data.analysis || data.advice) };
    })
  );

  const succeeded = results
    .filter((r) => r.status === "fulfilled" && r.value.hasData)
    .map((r) => r.value.projectId);

  cache.lastRefresh = new Date().toISOString();
  cache.error = null;

  log.info({
    total: TRACKED_PROJECTS.length,
    withData: succeeded.length,
    projects: succeeded,
  }, "Analytics Portfolio collector: refresh complete");
}

// -- Summary (for dashboard and health score) --
function getSummary() {
  const projectSummaries = {};
  let totalActivation = 0;
  let totalConversion = 0;
  let projectCount = 0;

  for (const [projectId, data] of Object.entries(cache.projects)) {
    const analysis = data.analysis;
    const advice = data.advice;

    if (!analysis && !advice) {
      projectSummaries[projectId] = { status: "NO_DATA", fetchedAt: data.fetchedAt };
      continue;
    }

    const summary = { status: "OK", fetchedAt: data.fetchedAt };

    if (analysis) {
      summary.totalSessions = analysis.totalSessions;
      summary.uniqueUsers = analysis.uniqueUsers;
      summary.activationRate = analysis.activationRate;
      summary.conversionRate = analysis.conversionRate;
      summary.coreActions = analysis.coreActions;
      summary.topEvents = (analysis.topEvents || []).slice(0, 5);
      summary.bounceRate = analysis.bounceRate;
      summary.avgSessionDurationSeconds = analysis.avgSessionDurationSeconds;

      totalActivation += analysis.activationRate;
      totalConversion += analysis.conversionRate;
      projectCount++;
    }

    if (advice) {
      summary.decision = advice.decision;
      summary.confidence = advice.confidence;
      summary.reason = advice.reason;
      summary.actions = advice.actions || [];
    }

    projectSummaries[projectId] = summary;
  }

  const avgActivationRate = projectCount > 0
    ? Math.round((totalActivation / projectCount) * 100) / 100
    : null;
  const avgConversionRate = projectCount > 0
    ? Math.round((totalConversion / projectCount) * 100) / 100
    : null;

  return {
    trackedProjects: TRACKED_PROJECTS,
    projectCount,
    avgActivationRate,
    avgConversionRate,
    projects: projectSummaries,
    lastRefresh: cache.lastRefresh,
    timestamp: new Date().toISOString(),
  };
}

// -- Per-project detail (for project view) --
function getProjectDetail(projectId) {
  const data = cache.projects[projectId];
  if (!data) return null;
  return {
    analysis: data.analysis,
    advice: data.advice,
    fetchedAt: data.fetchedAt,
  };
}

module.exports = {
  refreshAll,
  getSummary,
  getProjectDetail,
  REFRESH_INTERVAL,
};
