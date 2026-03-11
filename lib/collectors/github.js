// ============================================================================
// SITREP — GitHub Collector
// ============================================================================
// Collects: PRs, issues, commits, CI/test coverage, repo stats
// Source: GitHub REST API v3
// ============================================================================

const log = require("../logger");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;
const GITHUB_ORG = process.env.GITHUB_ORG || "bdelpech";

// Repos to monitor (mapped to SITREP app groups)
const REPOS = [
  { repo: "alert-immo",        group: "ALERT-IMMO",   lang: "java" },
  { repo: "exam-drilling",     group: "EXAM-DRILL",   lang: "java" },
  { repo: "rent-apply",        group: "RENT-APPLY",   lang: "typescript" },
  { repo: "smartresume",       group: "SMARTRESUME",   lang: "java" },
  { repo: "portfolio",         group: "PORTFOLIO",     lang: "typescript" },
  { repo: "sitrep",            group: "INFRA",         lang: "javascript" },
  { repo: "delpech-infra",     group: "INFRA",         lang: "terraform" },
  { repo: "delpech-toolskit",  group: "TOOLSKIT",      lang: "mixed" },
];

const cache = {
  repos: new Map(),       // repo → { stars, forks, openIssues, updatedAt, ... }
  prs: new Map(),         // repo → [PR...]
  commits: new Map(),     // repo → { total7d, total30d, authors, ... }
  ci: new Map(),          // repo → { lastRun, status, conclusion, ... }
  coverage: new Map(),    // repo → { lineCoverage, branchCoverage, ... }
  lastRefresh: null,
};

const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 min

function headers() {
  const h = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "SITREP/2.1",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (GITHUB_TOKEN) h["Authorization"] = `Bearer ${GITHUB_TOKEN}`;
  return h;
}

async function ghFetch(path) {
  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    headers: headers(),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const msg = `GitHub API ${res.status}: ${path}`;
    log.warn({ status: res.status, path }, msg);
    return null;
  }
  return res.json();
}

// ── Repo Stats ──────────────────────────────────────────────────────────────
async function fetchRepoStats(owner, repo) {
  const data = await ghFetch(`/repos/${owner}/${repo}`);
  if (!data) return null;
  return {
    name: data.full_name,
    description: data.description,
    language: data.language,
    stars: data.stargazers_count,
    forks: data.forks_count,
    openIssues: data.open_issues_count,
    size: data.size,
    defaultBranch: data.default_branch,
    updatedAt: data.updated_at,
    pushedAt: data.pushed_at,
    topics: data.topics || [],
    visibility: data.visibility,
    archived: data.archived,
    hasIssues: data.has_issues,
  };
}

// ── Open PRs ────────────────────────────────────────────────────────────────
async function fetchOpenPRs(owner, repo) {
  const data = await ghFetch(`/repos/${owner}/${repo}/pulls?state=open&per_page=10`);
  if (!data) return [];
  return data.map((pr) => ({
    number: pr.number,
    title: pr.title,
    author: pr.user?.login,
    state: pr.state,
    draft: pr.draft,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    labels: pr.labels?.map((l) => l.name) || [],
    reviewers: pr.requested_reviewers?.map((r) => r.login) || [],
    mergeable: pr.mergeable,
    url: pr.html_url,
  }));
}

// ── Recent Commits (7d/30d) ─────────────────────────────────────────────────
async function fetchCommitStats(owner, repo) {
  const now = new Date();
  const d7 = new Date(now - 7 * 86400000).toISOString();
  const d30 = new Date(now - 30 * 86400000).toISOString();

  const [recent7, recent30] = await Promise.all([
    ghFetch(`/repos/${owner}/${repo}/commits?since=${d7}&per_page=100`),
    ghFetch(`/repos/${owner}/${repo}/commits?since=${d30}&per_page=100`),
  ]);

  const authors7 = {};
  (recent7 || []).forEach((c) => {
    const a = c.commit?.author?.name || c.author?.login || "unknown";
    authors7[a] = (authors7[a] || 0) + 1;
  });

  return {
    total7d: (recent7 || []).length,
    total30d: (recent30 || []).length,
    authors7d: authors7,
    lastCommit: recent7?.[0]?.commit?.message?.substring(0, 80) || null,
    lastCommitDate: recent7?.[0]?.commit?.author?.date || null,
    lastCommitAuthor: recent7?.[0]?.commit?.author?.name || null,
  };
}

// ── CI/GitHub Actions ───────────────────────────────────────────────────────
async function fetchCIStatus(owner, repo) {
  const data = await ghFetch(`/repos/${owner}/${repo}/actions/runs?per_page=5`);
  if (!data?.workflow_runs?.length) return null;

  const runs = data.workflow_runs.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    branch: r.head_branch,
    event: r.event,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    url: r.html_url,
    durationMs: r.updated_at && r.created_at
      ? new Date(r.updated_at) - new Date(r.created_at)
      : null,
  }));

  const lastRun = runs[0];
  const successRate = runs.filter((r) => r.conclusion === "success").length / runs.length;

  return {
    lastRun,
    runs,
    successRate: Math.round(successRate * 100),
    totalRuns: data.total_count || runs.length,
  };
}

// ── Test Coverage (from CI artifacts or badges) ─────────────────────────────
async function fetchTestCoverage(owner, repo, lang) {
  // Try to get coverage from workflow artifacts or Codecov badge
  // For Java (JaCoCo), look for coverage badge in README
  // For TS (Jest/Vitest), look for coverage badge
  const readme = await ghFetch(`/repos/${owner}/${repo}/readme`);
  if (!readme?.content) return null;

  const decoded = Buffer.from(readme.content, "base64").toString("utf8");

  // Parse coverage badges (Codecov, Coveralls, custom)
  const coverageMatch = decoded.match(/coverage[:\-\s]*(\d+(?:\.\d+)?)\s*%/i)
    || decoded.match(/badge.*coverage.*?(\d+(?:\.\d+)?)/i);

  if (coverageMatch) {
    return {
      lineCoverage: parseFloat(coverageMatch[1]),
      source: "readme-badge",
      fetchedAt: new Date().toISOString(),
    };
  }

  // Fallback: check JaCoCo report artifact from latest CI run
  if (lang === "java") {
    const ciRuns = await ghFetch(`/repos/${owner}/${repo}/actions/runs?per_page=1&status=completed`);
    if (ciRuns?.workflow_runs?.[0]) {
      const artifacts = await ghFetch(
        `/repos/${owner}/${repo}/actions/runs/${ciRuns.workflow_runs[0].id}/artifacts`
      );
      const coverageArtifact = artifacts?.artifacts?.find(
        (a) => a.name.toLowerCase().includes("coverage") || a.name.toLowerCase().includes("jacoco")
      );
      if (coverageArtifact) {
        return {
          lineCoverage: null,
          artifactName: coverageArtifact.name,
          artifactSize: coverageArtifact.size_in_bytes,
          source: "ci-artifact",
          fetchedAt: new Date().toISOString(),
        };
      }
    }
  }

  return null;
}

// ── Issues (open count + labels breakdown) ──────────────────────────────────
async function fetchIssueStats(owner, repo) {
  const data = await ghFetch(`/repos/${owner}/${repo}/issues?state=open&per_page=100`);
  if (!data) return null;

  // Filter out PRs (GitHub API returns PRs as issues)
  const issues = data.filter((i) => !i.pull_request);

  const byLabel = {};
  const byPriority = { critical: 0, high: 0, medium: 0, low: 0, unlabeled: 0 };

  for (const issue of issues) {
    const labels = issue.labels?.map((l) => l.name.toLowerCase()) || [];
    for (const l of labels) {
      byLabel[l] = (byLabel[l] || 0) + 1;
    }
    if (labels.some((l) => l.includes("critical") || l.includes("p0") || l.includes("bug"))) {
      byPriority.critical++;
    } else if (labels.some((l) => l.includes("high") || l.includes("p1"))) {
      byPriority.high++;
    } else if (labels.some((l) => l.includes("medium") || l.includes("p2"))) {
      byPriority.medium++;
    } else if (labels.some((l) => l.includes("low") || l.includes("p3"))) {
      byPriority.low++;
    } else {
      byPriority.unlabeled++;
    }
  }

  return {
    totalOpen: issues.length,
    byLabel,
    byPriority,
    oldest: issues.length > 0
      ? { title: issues[issues.length - 1].title, createdAt: issues[issues.length - 1].created_at }
      : null,
  };
}

// ── Full Refresh ────────────────────────────────────────────────────────────
async function refreshAll() {
  if (!GITHUB_TOKEN) {
    log.warn("GITHUB_TOKEN not set — GitHub collector disabled");
    return;
  }

  log.info({ repos: REPOS.length }, "GitHub collector: refreshing all repos");

  for (const { repo, group, lang } of REPOS) {
    try {
      const [stats, prs, commits, ci, coverage, issues] = await Promise.all([
        fetchRepoStats(GITHUB_ORG, repo),
        fetchOpenPRs(GITHUB_ORG, repo),
        fetchCommitStats(GITHUB_ORG, repo),
        fetchCIStatus(GITHUB_ORG, repo),
        fetchTestCoverage(GITHUB_ORG, repo, lang),
        fetchIssueStats(GITHUB_ORG, repo),
      ]);

      cache.repos.set(repo, { ...stats, group, lang, issues });
      cache.prs.set(repo, prs);
      cache.commits.set(repo, commits);
      cache.ci.set(repo, ci);
      if (coverage) cache.coverage.set(repo, coverage);

      log.debug({ repo, prs: prs?.length, commits7d: commits?.total7d }, "GitHub repo refreshed");
    } catch (err) {
      log.error({ err: err.message, repo }, "GitHub collector failed for repo");
    }
  }

  cache.lastRefresh = new Date().toISOString();
  log.info({ repos: cache.repos.size, lastRefresh: cache.lastRefresh }, "GitHub collector: refresh complete");
}

// ── API Data ────────────────────────────────────────────────────────────────
function getSummary() {
  const repos = [];
  for (const { repo, group } of REPOS) {
    const stats = cache.repos.get(repo);
    const commits = cache.commits.get(repo);
    const ci = cache.ci.get(repo);
    const prs = cache.prs.get(repo) || [];
    const coverage = cache.coverage.get(repo);

    repos.push({
      repo,
      group,
      stats: stats || null,
      commits: commits || null,
      ci: ci ? {
        lastStatus: ci.lastRun?.conclusion,
        lastBranch: ci.lastRun?.branch,
        lastRunAt: ci.lastRun?.createdAt,
        successRate: ci.successRate,
        durationMs: ci.lastRun?.durationMs,
      } : null,
      prs: {
        open: prs.length,
        drafts: prs.filter((p) => p.draft).length,
        list: prs.slice(0, 5),
      },
      coverage: coverage || null,
      issues: stats?.issues || null,
    });
  }

  // Aggregate stats
  const totalCommits7d = repos.reduce((s, r) => s + (r.commits?.total7d || 0), 0);
  const totalCommits30d = repos.reduce((s, r) => s + (r.commits?.total30d || 0), 0);
  const totalOpenPRs = repos.reduce((s, r) => s + (r.prs?.open || 0), 0);
  const totalOpenIssues = repos.reduce((s, r) => s + (r.issues?.totalOpen || 0), 0);
  const ciGreen = repos.filter((r) => r.ci?.lastStatus === "success").length;
  const ciTotal = repos.filter((r) => r.ci).length;

  return {
    summary: {
      totalRepos: repos.length,
      totalCommits7d,
      totalCommits30d,
      totalOpenPRs,
      totalOpenIssues,
      ciGreen,
      ciTotal,
      ciHealthPct: ciTotal > 0 ? Math.round((ciGreen / ciTotal) * 100) : null,
    },
    repos,
    lastRefresh: cache.lastRefresh,
    timestamp: new Date().toISOString(),
  };
}

function getRepoDetail(repoName) {
  return {
    stats: cache.repos.get(repoName) || null,
    prs: cache.prs.get(repoName) || [],
    commits: cache.commits.get(repoName) || null,
    ci: cache.ci.get(repoName) || null,
    coverage: cache.coverage.get(repoName) || null,
  };
}

module.exports = {
  REPOS,
  refreshAll,
  getSummary,
  getRepoDetail,
  REFRESH_INTERVAL,
};
