// ============================================================================
// SITREP — Incident Persistence
// ============================================================================
// Saves incidents to data/incidents.json and reloads on startup.
// No more data loss on server restart.
// ============================================================================

const fs = require("fs");
const path = require("path");
const log = require("./logger");

const DATA_DIR = path.join(__dirname, "..", "data");
const INCIDENTS_FILE = path.join(DATA_DIR, "incidents.json");

/**
 * Load incidents from disk. Returns [] if file missing or corrupt.
 */
function loadIncidents() {
  try {
    if (!fs.existsSync(INCIDENTS_FILE)) return [];
    const raw = fs.readFileSync(INCIDENTS_FILE, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    log.info({ count: data.length, file: INCIDENTS_FILE }, "Incidents loaded from disk");
    return data;
  } catch (err) {
    log.warn({ err: err.message, file: INCIDENTS_FILE }, "Failed to load incidents — starting fresh");
    return [];
  }
}

/**
 * Save incidents to disk. Non-blocking, fire-and-forget with error logging.
 */
function saveIncidents(incidents) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(INCIDENTS_FILE, JSON.stringify(incidents, null, 2), "utf8");
  } catch (err) {
    log.error({ err: err.message, file: INCIDENTS_FILE }, "Failed to save incidents to disk");
  }
}

module.exports = { loadIncidents, saveIncidents };
