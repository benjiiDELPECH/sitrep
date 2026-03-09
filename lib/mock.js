// ============================================================================
// SITREP — Mock Health Provider
// ============================================================================
// When MOCK_MODE=true, replaces real HTTP polling with simulated responses.
// Targets cycle through OPERATIONAL/DEGRADED/DOWN with realistic latencies.
// Perfect for local dev/testing without hitting production endpoints.
// ============================================================================

const log = require("./logger");

// Weighted random status: 80% UP, 10% DEGRADED, 10% DOWN
function randomStatus() {
  const r = Math.random();
  if (r < 0.80) return "OPERATIONAL";
  if (r < 0.90) return "DEGRADED";
  return "DOWN";
}

// Sticky state: each target keeps its state for 2-5 cycles before changing
const stickyState = new Map(); // id → { status, ttl }

function getMockStatus(targetId) {
  const state = stickyState.get(targetId);
  if (state && state.ttl > 0) {
    state.ttl--;
    return state.status;
  }
  const newStatus = randomStatus();
  stickyState.set(targetId, { status: newStatus, ttl: 2 + Math.floor(Math.random() * 4) });
  return newStatus;
}

/**
 * Simulate a health check for a target.
 * @param {object} target - Target config object from config.js
 * @returns {object} - Same shape as real checkTarget() result
 */
function mockCheckTarget(target) {
  const status = getMockStatus(target.id);
  const latency = status === "OPERATIONAL"
    ? 20 + Math.floor(Math.random() * 80)   // 20-100ms
    : status === "DEGRADED"
    ? 200 + Math.floor(Math.random() * 800)  // 200-1000ms
    : 3000 + Math.floor(Math.random() * 5000); // 3-8s timeout

  const httpCode = status === "OPERATIONAL" ? 200
    : status === "DEGRADED" ? 503
    : null;

  const error = status === "DOWN" ? "MOCK_TIMEOUT" : status === "DEGRADED" ? "HTTP_503" : null;

  const result = {
    id: target.id,
    status,
    httpCode,
    latency,
    details: status === "OPERATIONAL" && target.type === "spring-boot"
      ? { status: "UP" }
      : null,
    components: null,
    lastCheck: new Date().toISOString(),
    error,
    diagnosis: status === "DOWN" ? {
      failedAt: "TCP",
      code: "TCP_TIMEOUT",
      layers: { dns: { ok: true }, tcp: { ok: false, error: "MOCK_TIMEOUT" }, tls: null },
      message: `[MOCK] TCP connection to ${target.id} timed out`,
    } : null,
  };

  return result;
}

/**
 * Mock SSL cert check — returns fake cert info.
 */
function mockCheckCert(hostname) {
  const daysLeft = 30 + Math.floor(Math.random() * 300);
  return {
    hostname,
    validTo: new Date(Date.now() + daysLeft * 86400000).toISOString(),
    daysLeft,
    issuer: "Let's Encrypt",
    subject: hostname,
    checkedAt: new Date().toISOString(),
  };
}

log.info("Mock health provider loaded — no production endpoints will be contacted");

module.exports = { mockCheckTarget, mockCheckCert };
