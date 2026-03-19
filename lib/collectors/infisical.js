// ============================================================================
// SITREP — Infisical Secret Management Collector
// ============================================================================
// Monitors Infisical health and InfisicalSecret CRD sync status:
//   1. Infisical server availability (health endpoint)
//   2. InfisicalSecret CRDs across all namespaces (K8s API)
//   3. Sync status per secret (conditions from CRD status)
//   4. Summary: total, synced, errored, stale
//
// Requires (env vars):
//   INFISICAL_URL           — Infisical server URL (e.g. https://secrets.delpech.cloud)
//   KUBERNETES_SERVICE_HOST — Set automatically when running in-cluster
//
// K8s RBAC needed:
//   ClusterRole: get, list on secrets.infisical.com/infisicalsecrets
// ============================================================================

const log = require("../logger");
const fs = require("fs");
const https = require("https");

// ── Configuration ───────────────────────────────────────────────────────────

const INFISICAL_URL = process.env.INFISICAL_URL || "";
const K8S_HOST = process.env.KUBERNETES_SERVICE_HOST || "";
const K8S_PORT = process.env.KUBERNETES_SERVICE_PORT || "443";
const REFRESH_INTERVAL = 2 * 60 * 1000; // 2 min

// In-cluster paths (mounted by K8s automatically)
const TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

// CRD API group / version (Infisical Operator)
const CRD_GROUP = "secrets.infisical.com";
const CRD_VERSION = "v1alpha1";
const CRD_PLURAL = "infisicalsecrets";

// ── Cache ───────────────────────────────────────────────────────────────────

const cache = {
  server: null,       // { status, version, latencyMs }
  secrets: [],        // [{ name, namespace, syncStatus, lastSynced, managedSecret, error }]
  summary: null,      // { total, synced, errored, stale, unknown }
  alerts: [],
  lastRefresh: null,
};

// ── K8s In-Cluster Client ───────────────────────────────────────────────────

function isInCluster() {
  return !!K8S_HOST && fs.existsSync(TOKEN_PATH);
}

function getServiceAccountToken() {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * Fetch from K8s API (in-cluster). Uses the service account token for auth.
 * @param {string} apiPath — e.g. /apis/secrets.infisical.com/v1alpha1/infisicalsecrets
 * @returns {Promise<object>}
 */
async function k8sFetch(apiPath) {
  const token = getServiceAccountToken();
  if (!token) throw new Error("No service account token available");

  const url = `https://${K8S_HOST}:${K8S_PORT}${apiPath}`;

  const ca = fs.existsSync(CA_PATH) ? fs.readFileSync(CA_PATH) : undefined;

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      ca,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`K8s API ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Invalid K8s API JSON: ${err.message}`));
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

// ── Check Infisical Server Health ───────────────────────────────────────────

async function checkServer() {
  if (!INFISICAL_URL) {
    return { status: "UNCONFIGURED", error: "INFISICAL_URL not set" };
  }

  const start = Date.now();
  try {
    const res = await fetch(`${INFISICAL_URL}/api/status`, {
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - start;

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      return {
        status: "UP",
        latencyMs,
        version: data.version || data.message || "unknown",
      };
    }

    return { status: "DEGRADED", latencyMs, error: `HTTP ${res.status}` };
  } catch (err) {
    return { status: "DOWN", latencyMs: Date.now() - start, error: err.message };
  }
}

// ── List InfisicalSecret CRDs Across All Namespaces ─────────────────────────

async function listInfisicalSecrets() {
  if (!isInCluster()) {
    return { available: false, reason: "Not running in K8s cluster" };
  }

  try {
    const apiPath = `/apis/${CRD_GROUP}/${CRD_VERSION}/${CRD_PLURAL}`;
    const data = await k8sFetch(apiPath);

    const secrets = (data.items || []).map((item) => {
      const meta = item.metadata || {};
      const spec = item.spec || {};
      const status = item.status || {};
      const conditions = status.conditions || [];

      // Find the "Ready" or "Synced" condition
      const readyCondition = conditions.find(
        (c) => c.type === "Ready" || c.type === "Synced" || c.type === "secrets.infisical.com/ReadyToSyncSecrets"
      );

      // Determine sync status
      let syncStatus = "unknown";
      let lastSynced = null;
      let error = null;

      if (readyCondition) {
        syncStatus = readyCondition.status === "True" ? "synced" : "error";
        lastSynced = readyCondition.lastTransitionTime || null;
        if (readyCondition.status !== "True") {
          error = readyCondition.message || readyCondition.reason || "Sync failed";
        }
      }

      // Check staleness (>10 min since last sync)
      if (syncStatus === "synced" && lastSynced) {
        const age = Date.now() - new Date(lastSynced).getTime();
        if (age > 10 * 60 * 1000) {
          syncStatus = "stale";
        }
      }

      return {
        name: meta.name,
        namespace: meta.namespace,
        syncStatus,
        lastSynced,
        managedSecret: spec.managedSecretReference?.secretName || null,
        secretType: spec.authentication ? Object.keys(spec.authentication)[0] : "unknown",
        error,
        conditions,
      };
    });

    return { available: true, secrets };
  } catch (err) {
    log.warn({ err: err.message }, "Failed to list InfisicalSecret CRDs");
    return { available: false, reason: err.message };
  }
}

// ── Build Summary ───────────────────────────────────────────────────────────

function buildSummary(secrets) {
  const total = secrets.length;
  const synced = secrets.filter((s) => s.syncStatus === "synced").length;
  const errored = secrets.filter((s) => s.syncStatus === "error").length;
  const stale = secrets.filter((s) => s.syncStatus === "stale").length;
  const unknown = secrets.filter((s) => s.syncStatus === "unknown").length;

  return { total, synced, errored, stale, unknown };
}

// ── Main Collector ──────────────────────────────────────────────────────────

async function collect() {
  const needsRefresh = !cache.lastRefresh || Date.now() - cache.lastRefresh > REFRESH_INTERVAL;
  if (!needsRefresh) return cache;

  log.info("Infisical collector: running health checks...");

  // Run checks in parallel
  const [server, crdResult] = await Promise.all([
    checkServer(),
    listInfisicalSecrets(),
  ]);

  cache.server = server;

  if (crdResult.available) {
    cache.secrets = crdResult.secrets;
    cache.summary = buildSummary(crdResult.secrets);
  } else {
    cache.secrets = [];
    cache.summary = { total: 0, synced: 0, errored: 0, stale: 0, unknown: 0, unavailable: crdResult.reason };
  }

  cache.lastRefresh = Date.now();

  // Build alerts
  cache.alerts = [];

  if (server.status === "DOWN") {
    cache.alerts.push(`🔴 Infisical server DOWN: ${server.error}`);
  } else if (server.status === "DEGRADED") {
    cache.alerts.push(`🟠 Infisical server degraded: ${server.error}`);
  }

  const erroredSecrets = cache.secrets.filter((s) => s.syncStatus === "error");
  for (const s of erroredSecrets) {
    cache.alerts.push(`🔴 InfisicalSecret ${s.namespace}/${s.name} sync error: ${s.error}`);
  }

  const staleSecrets = cache.secrets.filter((s) => s.syncStatus === "stale");
  for (const s of staleSecrets) {
    cache.alerts.push(`🟠 InfisicalSecret ${s.namespace}/${s.name} stale (last sync: ${s.lastSynced})`);
  }

  if (cache.alerts.length > 0) {
    log.warn({ alerts: cache.alerts }, "Infisical health alerts!");
  } else {
    log.info({
      server: server.status,
      crds: cache.summary.total,
      synced: cache.summary.synced,
    }, "Infisical health: all checks passed");
  }

  return cache;
}

function getData() {
  return cache;
}

function getSummary() {
  return {
    server: cache.server,
    summary: cache.summary,
    secrets: cache.secrets.map((s) => ({
      name: s.name,
      namespace: s.namespace,
      syncStatus: s.syncStatus,
      lastSynced: s.lastSynced,
      managedSecret: s.managedSecret,
      error: s.error,
    })),
    alerts: cache.alerts,
    lastRefresh: cache.lastRefresh,
  };
}

module.exports = { collect, refreshAll: collect, getData, getSummary, REFRESH_INTERVAL };
