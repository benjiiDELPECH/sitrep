// ============================================================================
// SITREP — Notion Sync Collector
// ============================================================================
// Syncs project roadmaps, planning, and post-mortems from Notion.
// Uses the Notion API to pull structured data for the monitoring hub.
//
// Required: NOTION_API_TOKEN env var (internal integration token)
// ============================================================================

const log = require("../logger");

const NOTION_TOKEN = process.env.NOTION_API_TOKEN || null;
const NOTION_VERSION = "2022-06-28";

// Known Notion database/page IDs (from workspace search)
const NOTION_SOURCES = {
  roadmap: process.env.NOTION_ROADMAP_DB_ID || "169cddf4-fe48-80be-90b8-f24e21c75ff9",
  pilotage: process.env.NOTION_PILOTAGE_PAGE_ID || "2f5cddf4-fe48-8083-8d52-f90f52210966",
  architecture: process.env.NOTION_ARCHI_PAGE_ID || "31acddf4-fe48-81e2-9ec0-e4ab551eca7d",
};

const cache = {
  roadmap: [],
  postMortems: [],
  incidents: [],
  lastRefresh: null,
};

const REFRESH_INTERVAL = 10 * 60 * 1000; // 10 min

function headers() {
  return {
    "Authorization": `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function notionFetch(path, method = "GET", body = null) {
  const url = `https://api.notion.com/v1${path}`;
  const opts = {
    method,
    headers: headers(),
    signal: AbortSignal.timeout(15000),
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    log.warn({ status: res.status, path }, `Notion API ${res.status}`);
    return null;
  }
  return res.json();
}

// ── Roadmap Items ───────────────────────────────────────────────────────────
async function fetchRoadmap() {
  const dbId = NOTION_SOURCES.roadmap;
  const data = await notionFetch(`/databases/${dbId}/query`, "POST", {
    sorts: [{ property: "Created time", direction: "descending" }],
    page_size: 50,
  });

  if (!data?.results) return [];

  return data.results.map((page) => {
    const props = page.properties || {};
    return {
      id: page.id,
      title: extractTitle(props),
      status: extractSelect(props, "Status") || extractSelect(props, "Statut"),
      priority: extractSelect(props, "Priority") || extractSelect(props, "Priorité"),
      project: extractSelect(props, "Project") || extractSelect(props, "Projet"),
      assignee: extractPeople(props, "Assign") || extractPeople(props, "Assignee"),
      dueDate: extractDate(props, "Due") || extractDate(props, "Date"),
      tags: extractMultiSelect(props, "Tags"),
      createdAt: page.created_time,
      updatedAt: page.last_edited_time,
      url: page.url,
    };
  });
}

// ── Property Extractors ─────────────────────────────────────────────────────
function extractTitle(props) {
  for (const [, val] of Object.entries(props)) {
    if (val.type === "title" && val.title?.length > 0) {
      return val.title.map((t) => t.plain_text).join("");
    }
  }
  return "Untitled";
}

function extractSelect(props, ...names) {
  for (const name of names) {
    for (const [key, val] of Object.entries(props)) {
      if (key.toLowerCase().includes(name.toLowerCase()) && val.type === "select") {
        return val.select?.name || null;
      }
    }
  }
  return null;
}

function extractMultiSelect(props, ...names) {
  for (const name of names) {
    for (const [key, val] of Object.entries(props)) {
      if (key.toLowerCase().includes(name.toLowerCase()) && val.type === "multi_select") {
        return val.multi_select?.map((s) => s.name) || [];
      }
    }
  }
  return [];
}

function extractPeople(props, ...names) {
  for (const name of names) {
    for (const [key, val] of Object.entries(props)) {
      if (key.toLowerCase().includes(name.toLowerCase()) && val.type === "people") {
        return val.people?.map((p) => p.name).join(", ") || null;
      }
    }
  }
  return null;
}

function extractDate(props, ...names) {
  for (const name of names) {
    for (const [key, val] of Object.entries(props)) {
      if (key.toLowerCase().includes(name.toLowerCase()) && val.type === "date") {
        return val.date?.start || null;
      }
    }
  }
  return null;
}

// ── Roadmap Analytics ───────────────────────────────────────────────────────
function analyzeRoadmap(items) {
  const byStatus = {};
  const byProject = {};
  const byPriority = {};

  for (const item of items) {
    const status = item.status || "No Status";
    byStatus[status] = (byStatus[status] || 0) + 1;

    const project = item.project || "Unassigned";
    byProject[project] = (byProject[project] || 0) + 1;

    const priority = item.priority || "None";
    byPriority[priority] = (byPriority[priority] || 0) + 1;
  }

  // Overdue items (due date in the past, not completed)
  const now = new Date();
  const overdue = items.filter((i) => {
    if (!i.dueDate) return false;
    const due = new Date(i.dueDate);
    const status = (i.status || "").toLowerCase();
    return due < now && !status.includes("done") && !status.includes("complet");
  });

  // Recently updated (last 7 days)
  const d7 = new Date(now - 7 * 86400000);
  const recentlyUpdated = items.filter((i) => new Date(i.updatedAt) > d7);

  return {
    total: items.length,
    byStatus,
    byProject,
    byPriority,
    overdue: overdue.length,
    overdueItems: overdue.slice(0, 10),
    recentlyUpdated: recentlyUpdated.length,
    velocity7d: recentlyUpdated.filter((i) =>
      (i.status || "").toLowerCase().includes("done") || (i.status || "").toLowerCase().includes("complet")
    ).length,
  };
}

// ── Full Refresh ────────────────────────────────────────────────────────────
async function refreshAll() {
  if (!NOTION_TOKEN) {
    log.warn("NOTION_API_TOKEN not set — Notion sync disabled");
    return;
  }

  log.info("Notion sync: refreshing");

  try {
    cache.roadmap = await fetchRoadmap();
    log.info({ items: cache.roadmap.length }, "Notion roadmap refreshed");
  } catch (err) {
    log.error({ err: err.message }, "Notion roadmap fetch failed");
  }

  cache.lastRefresh = new Date().toISOString();
}

function getSummary() {
  const analytics = analyzeRoadmap(cache.roadmap);

  return {
    roadmap: {
      items: cache.roadmap.slice(0, 30),
      analytics,
    },
    sources: {
      roadmapDbId: NOTION_SOURCES.roadmap,
      pilotagePageId: NOTION_SOURCES.pilotage,
    },
    lastRefresh: cache.lastRefresh,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  refreshAll,
  getSummary,
  REFRESH_INTERVAL,
};
