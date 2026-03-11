// ============================================================================
// SITREP — Code Intelligence Collector (Neo4j)
// ============================================================================
// Collects: code complexity, LOC per project, class/method counts,
//           dependency graph density, dead code detection
// Source: Neo4j Code Graph (CodeGra)
// ============================================================================

const log = require("../logger");

const NEO4J_BOLT_URL = process.env.NEO4J_BOLT_URL || "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || "";

// Project → filePath pattern mapping
const PROJECT_PATTERNS = {
  "alert-immo":      "alert-immo|analytics-service",
  "exam-drilling":   "exam-drilling|exam-drill",
  "rent-apply":      "rent-apply",
  "smartresume":     "smartresume",
  "portfolio":       "portfolio",
  "sitrep":          "sitrep",
  "delpech-infra":   "delpech-infra",
  "delpech-toolskit":"delpech-toolskit",
};

const cache = {
  projects: new Map(),
  aggregate: null,
  lastRefresh: null,
};

const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 min (code doesn't change that fast)

// ── Neo4j Driver (lazy init) ────────────────────────────────────────────────
let driver = null;

function getDriver() {
  if (driver) return driver;
  try {
    const neo4j = require("neo4j-driver");
    driver = neo4j.driver(NEO4J_BOLT_URL, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
    log.info({ url: NEO4J_BOLT_URL }, "Neo4j driver initialized");
    return driver;
  } catch (err) {
    log.warn({ err: err.message }, "Neo4j driver not available — code intelligence disabled");
    return null;
  }
}

async function runQuery(query, params = {}) {
  const d = getDriver();
  if (!d) return null;
  const session = d.session();
  try {
    const result = await session.run(query, params);
    return result.records.map((r) => {
      const obj = {};
      r.keys.forEach((k) => {
        const val = r.get(k);
        obj[k] = typeof val?.toNumber === "function" ? val.toNumber() : val;
      });
      return obj;
    });
  } finally {
    await session.close();
  }
}

// ── Per-Project Code Metrics ────────────────────────────────────────────────
async function fetchProjectMetrics(projectName, pattern) {
  const regexPattern = `(?i).*(${pattern}).*`;

  // Files, LOC, Languages
  const fileStats = await runQuery(`
    MATCH (f:File)
    WHERE f.filePath =~ $pattern
    RETURN f.language AS language, count(f) AS files, sum(COALESCE(f.linesOfCode, 0)) AS loc
    ORDER BY files DESC
  `, { pattern: regexPattern });

  // Classes & Methods (Java)
  const classStats = await runQuery(`
    MATCH (f:File)-[:DEFINES_CLASS]->(c:JavaClass)
    WHERE f.filePath =~ $pattern
    OPTIONAL MATCH (c)-[:HAS_METHOD]->(m:JavaMethod)
    RETURN count(DISTINCT c) AS classes, count(DISTINCT m) AS methods
  `, { pattern: regexPattern });

  // Functions (TS/JS)
  const funcStats = await runQuery(`
    MATCH (f:File)
    WHERE f.filePath =~ $pattern
    OPTIONAL MATCH (f)<-[:HAS_PARAMETER]-(fn:Function)
    RETURN count(DISTINCT fn) AS functions
  `, { pattern: regexPattern });

  // Interfaces
  const interfaceStats = await runQuery(`
    MATCH (f:File)
    WHERE f.filePath =~ $pattern
    OPTIONAL MATCH (f)-[:DEFINES_INTERFACE]->(i)
    RETURN count(DISTINCT i) AS interfaces
  `, { pattern: regexPattern });

  // Complexity hotspots (top 10 most complex functions)
  const complexFunctions = await runQuery(`
    MATCH (fn:Function)
    WHERE fn.filePath =~ $pattern AND fn.complexity IS NOT NULL
    RETURN fn.name AS name, fn.filePath AS file, fn.complexity AS complexity, fn.loc AS loc
    ORDER BY fn.complexity DESC
    LIMIT 10
  `, { pattern: regexPattern });

  // Call graph density (cross-file calls)
  const callGraphDensity = await runQuery(`
    MATCH (f1:Function)-[c:CALLS]->(f2:Function)
    WHERE f1.filePath =~ $pattern AND c.isCrossFile = true
    RETURN count(c) AS crossFileCalls
  `, { pattern: regexPattern });

  // Error handling coverage
  const errorHandling = await runQuery(`
    MATCH (fn:Function)-[h:HANDLES_ERROR]-()
    WHERE fn.filePath =~ $pattern
    RETURN count(DISTINCT fn) AS functionsWithErrorHandling
  `, { pattern: regexPattern });

  const totalFiles = (fileStats || []).reduce((s, r) => s + r.files, 0);
  const totalLOC = (fileStats || []).reduce((s, r) => s + r.loc, 0);
  const languages = (fileStats || []).reduce((acc, r) => {
    acc[r.language] = { files: r.files, loc: r.loc };
    return acc;
  }, {});

  return {
    project: projectName,
    totalFiles,
    totalLOC,
    languages,
    classes: classStats?.[0]?.classes || 0,
    methods: classStats?.[0]?.methods || 0,
    functions: funcStats?.[0]?.functions || 0,
    interfaces: interfaceStats?.[0]?.interfaces || 0,
    complexityHotspots: complexFunctions || [],
    crossFileCalls: callGraphDensity?.[0]?.crossFileCalls || 0,
    errorHandlingCoverage: errorHandling?.[0]?.functionsWithErrorHandling || 0,
    healthScore: calculateHealthScore({
      totalFiles,
      totalLOC,
      complexFunctions,
      errorHandling: errorHandling?.[0]?.functionsWithErrorHandling || 0,
    }),
  };
}

function calculateHealthScore({ totalFiles, totalLOC, complexFunctions, errorHandling }) {
  let score = 100;

  // Penalize high complexity functions
  const highComplexity = (complexFunctions || []).filter((f) => f.complexity > 10);
  score -= highComplexity.length * 3;

  // Penalize very large files (avg LOC per file > 300)
  if (totalFiles > 0 && totalLOC / totalFiles > 300) {
    score -= 10;
  }

  // Bonus for error handling coverage
  if (errorHandling > 5) score += 5;

  return Math.max(0, Math.min(100, score));
}

// ── Full Refresh ────────────────────────────────────────────────────────────
async function refreshAll() {
  if (!NEO4J_PASSWORD) {
    log.warn("NEO4J_PASSWORD not set — code intelligence disabled");
    return;
  }

  log.info("Code Intelligence: refreshing all projects");

  for (const [project, pattern] of Object.entries(PROJECT_PATTERNS)) {
    try {
      const metrics = await fetchProjectMetrics(project, pattern);
      cache.projects.set(project, metrics);
      log.debug({ project, files: metrics.totalFiles, loc: metrics.totalLOC }, "Project metrics refreshed");
    } catch (err) {
      log.error({ err: err.message, project }, "Code intelligence failed for project");
    }
  }

  // Aggregate
  const allProjects = [...cache.projects.values()];
  cache.aggregate = {
    totalProjects: allProjects.length,
    totalFiles: allProjects.reduce((s, p) => s + p.totalFiles, 0),
    totalLOC: allProjects.reduce((s, p) => s + p.totalLOC, 0),
    totalClasses: allProjects.reduce((s, p) => s + p.classes, 0),
    totalMethods: allProjects.reduce((s, p) => s + p.methods, 0),
    totalFunctions: allProjects.reduce((s, p) => s + p.functions, 0),
    avgHealthScore: allProjects.length > 0
      ? Math.round(allProjects.reduce((s, p) => s + p.healthScore, 0) / allProjects.length)
      : 0,
  };

  cache.lastRefresh = new Date().toISOString();
  log.info({ projects: cache.projects.size, aggregate: cache.aggregate }, "Code Intelligence: refresh complete");
}

function getSummary() {
  return {
    aggregate: cache.aggregate,
    projects: Object.fromEntries(cache.projects),
    lastRefresh: cache.lastRefresh,
    timestamp: new Date().toISOString(),
  };
}

function getProjectDetail(projectName) {
  return cache.projects.get(projectName) || null;
}

async function shutdown() {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

module.exports = {
  PROJECT_PATTERNS,
  refreshAll,
  getSummary,
  getProjectDetail,
  shutdown,
  REFRESH_INTERVAL,
};
