// ============================================================================
// SITREP — Auth0 Health Collector
// ============================================================================
// Monitors Auth0 tenant health:
//   1. Tenant availability (OIDC discovery endpoint)
//   2. Google OAuth flow (redirect to accounts.google.com)
//   3. Login failure rate (Auth0 Management API logs)
//   4. Client configuration sanity (token_endpoint_auth_method)
//
// Requires:
//   AUTH0_DOMAIN        — Auth0 tenant domain
//   AUTH0_CLIENT_ID     — M2M app client_id (Terraform)
//   AUTH0_CLIENT_SECRET — M2M app client_secret
//   AUTH0_SPA_CLIENT_ID — SPA app client_id (for OAuth flow check)
// ============================================================================

const log = require("../logger");

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN || "";
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID || "";
const AUTH0_CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET || "";
const AUTH0_SPA_CLIENT_ID = process.env.AUTH0_SPA_CLIENT_ID || "";

const REFRESH_INTERVAL = 3 * 60 * 1000; // 3 min

const cache = {
  tenant: null,       // { status, issuer, latencyMs }
  googleOAuth: null,  // { status, redirectsTo, latencyMs }
  failureRate: null,  // { status, total, failures, rate, window }
  clientConfig: null, // { status, tokenEndpointAuth, appType }
  alerts: [],
  lastRefresh: null,
};

// ── M2M Token ───────────────────────────────────────────────────────────────

let m2mToken = null;
let m2mTokenExpiry = 0;

async function getM2MToken() {
  if (m2mToken && Date.now() < m2mTokenExpiry) return m2mToken;
  if (!AUTH0_CLIENT_ID || !AUTH0_CLIENT_SECRET) return null;

  try {
    const res = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: AUTH0_CLIENT_ID,
        client_secret: AUTH0_CLIENT_SECRET,
        audience: `https://${AUTH0_DOMAIN}/api/v2/`,
        grant_type: "client_credentials",
      }),
    });
    const data = await res.json();
    if (data.access_token) {
      m2mToken = data.access_token;
      m2mTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
      return m2mToken;
    }
    log.error({ error: data.error }, "Auth0 M2M token fetch failed");
    return null;
  } catch (err) {
    log.error({ err: err.message }, "Auth0 M2M token fetch error");
    return null;
  }
}

// ── Check 1: Tenant Availability ────────────────────────────────────────────

async function checkTenant() {
  const url = `https://${AUTH0_DOMAIN}/.well-known/openid-configuration`;
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const latencyMs = Date.now() - start;
    if (!res.ok) return { status: "DOWN", latencyMs, error: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      status: "UP",
      issuer: data.issuer,
      latencyMs,
    };
  } catch (err) {
    return { status: "DOWN", latencyMs: Date.now() - start, error: err.message };
  }
}

// ── Check 2: Google OAuth Flow ──────────────────────────────────────────────

async function checkGoogleOAuthFlow() {
  if (!AUTH0_SPA_CLIENT_ID) return { status: "SKIP", reason: "No SPA client_id" };

  const url = `https://${AUTH0_DOMAIN}/authorize?` + new URLSearchParams({
    response_type: "code",
    client_id: AUTH0_SPA_CLIENT_ID,
    redirect_uri: "https://www.real-estate-analytics.com",
    scope: "openid profile email",
    connection: "google-oauth2",
    state: "healthcheck",
  });

  const start = Date.now();
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8000) });
    const latencyMs = Date.now() - start;
    const location = res.headers.get("location") || "";

    if (res.status === 302 && location.startsWith("https://accounts.google.com")) {
      return { status: "UP", redirectsTo: "accounts.google.com", latencyMs };
    }
    return {
      status: "DOWN",
      error: `Expected 302→Google, got ${res.status} → ${location.substring(0, 80)}`,
      latencyMs,
    };
  } catch (err) {
    return { status: "DOWN", latencyMs: Date.now() - start, error: err.message };
  }
}

// ── Check 3: Login Failure Rate ─────────────────────────────────────────────

async function checkFailureRate() {
  const token = await getM2MToken();
  if (!token) return { status: "SKIP", reason: "No M2M token" };

  try {
    // Fetch last 100 login events (success + failure) from the last hour
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const params = new URLSearchParams({
      per_page: "100",
      sort: "date:-1",
      q: `date:[${since} TO *] AND (type:s OR type:f OR type:fp OR type:fu OR type:feacft)`,
    });

    const res = await fetch(`https://${AUTH0_DOMAIN}/api/v2/logs?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { status: "ERROR", error: `API ${res.status}` };

    const logs = await res.json();
    const total = logs.length;
    const failures = logs.filter(l => ["f", "fp", "fu", "feacft"].includes(l.type)).length;
    const rate = total > 0 ? (failures / total * 100).toFixed(1) : 0;

    // Alert if failure rate > 20% with at least 5 events
    const status = (total >= 5 && rate > 20) ? "ALERT" : "UP";

    return {
      status,
      total,
      failures,
      rate: `${rate}%`,
      window: "1h",
    };
  } catch (err) {
    return { status: "ERROR", error: err.message };
  }
}

// ── Check 4: Client Configuration Sanity ────────────────────────────────────

async function checkClientConfig() {
  const token = await getM2MToken();
  if (!token || !AUTH0_SPA_CLIENT_ID) return { status: "SKIP", reason: "No token or SPA client_id" };

  try {
    const res = await fetch(`https://${AUTH0_DOMAIN}/api/v2/clients/${AUTH0_SPA_CLIENT_ID}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { status: "ERROR", error: `API ${res.status}` };

    const client = await res.json();
    const authMethod = client.token_endpoint_auth_method;
    const appType = client.app_type;

    // A SPA MUST have token_endpoint_auth_method = "none" for PKCE
    if (appType === "spa" && authMethod !== "none") {
      return {
        status: "ALERT",
        error: `SPA has token_endpoint_auth_method="${authMethod}" instead of "none" — PKCE will fail!`,
        appType,
        tokenEndpointAuth: authMethod,
      };
    }

    return {
      status: "UP",
      appType,
      tokenEndpointAuth: authMethod,
    };
  } catch (err) {
    return { status: "ERROR", error: err.message };
  }
}

// ── Main Collector ──────────────────────────────────────────────────────────

async function collect() {
  if (!AUTH0_DOMAIN) {
    log.warn("Auth0 collector: AUTH0_DOMAIN not set, skipping");
    return cache;
  }

  const needsRefresh = !cache.lastRefresh || Date.now() - cache.lastRefresh > REFRESH_INTERVAL;
  if (!needsRefresh) return cache;

  log.info("Auth0 collector: running health checks...");

  const [tenant, googleOAuth, failureRate, clientConfig] = await Promise.all([
    checkTenant(),
    checkGoogleOAuthFlow(),
    checkFailureRate(),
    checkClientConfig(),
  ]);

  cache.tenant = tenant;
  cache.googleOAuth = googleOAuth;
  cache.failureRate = failureRate;
  cache.clientConfig = clientConfig;
  cache.lastRefresh = Date.now();

  // Build alerts
  cache.alerts = [];
  if (tenant.status === "DOWN") cache.alerts.push(`🔴 Auth0 tenant DOWN: ${tenant.error}`);
  if (googleOAuth.status === "DOWN") cache.alerts.push(`🔴 Google OAuth flow broken: ${googleOAuth.error}`);
  if (failureRate.status === "ALERT") cache.alerts.push(`🟠 High login failure rate: ${failureRate.rate} (${failureRate.failures}/${failureRate.total} in ${failureRate.window})`);
  if (clientConfig.status === "ALERT") cache.alerts.push(`🔴 ${clientConfig.error}`);

  if (cache.alerts.length > 0) {
    log.warn({ alerts: cache.alerts }, "Auth0 health alerts!");
  } else {
    log.info({
      tenant: tenant.status,
      google: googleOAuth.status,
      failures: `${failureRate.rate || "N/A"}`,
      client: clientConfig.status,
    }, "Auth0 health: all checks passed");
  }

  return cache;
}

function getData() {
  return cache;
}

module.exports = { collect, refreshAll: collect, getData, REFRESH_INTERVAL };
