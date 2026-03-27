const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");


const RESET = "\x1b[0m";
const CHONKER_DIR = path.join(os.homedir(), ".chonker");
const CONFIG_PATH = path.join(CHONKER_DIR, "config.json");
const SESSION_PATH = path.join(CHONKER_DIR, "session.json");
const USAGE_CACHE_PATH = path.join(CHONKER_DIR, "usage.json");
const USAGE_GOOD_PATH = path.join(CHONKER_DIR, "usage_good.json");
const VELOCITY_PATH = path.join(CHONKER_DIR, "velocity.json");
const VELOCITIES_PATH = path.join(CHONKER_DIR, "velocities.json");
const CREDENTIALS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");

const USAGE_API_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_API_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "claude-code/2.0.32",
  "anthropic-beta": "oauth-2025-04-20",
};

const CACHE_TTL_SECONDS = 150;
const API_TIMEOUT_SECONDS = 3;
const CACHE_GRACE_SECONDS = 900;

// 256 color ansi codes unless noted
const DEFAULTS = {
  accent: 208,
  normal: 255,
  warning: 208,
  danger: 160,
  critical: 196,
  tokens: 80,
  dim: 242,
  bar_width: 20,
  show_usage: true,
  show_resets: true,
  cache_ttl: 150,
  // context bar color thresholds (percentage)
  threshold_warning: 50,
  threshold_danger: 70,
  threshold_critical: 85,
  // compact awareness
  compact_enabled: false,
  compact_threshold: 0,
  // burn rate prediction
  show_predictions: true,
  prediction_horizon: 3,
};

// maps api response keys to display labels, null buckets are skipped
const USAGE_BUCKETS = [
  ["five_hour", "5h"],
  ["seven_day", "7d"],
  ["seven_day_opus", "opus"],
  ["seven_day_sonnet", "sonnet"],
];

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, data) {
  // atomic write via tmp file to prevent corruption on crash
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, filePath);
}

function loadConfig() {
  return { ...DEFAULTS, ...loadJson(CONFIG_PATH, {}) };
}

function c256(n) {
  return `\x1b[38;5;${n}m`;
}

function pickBarColor(pct, cfg) {
  const critical = cfg.threshold_critical || 85;
  const danger = cfg.threshold_danger || 70;
  const warning = cfg.threshold_warning || 50;
  if (pct > critical) return c256(cfg.critical);
  if (pct > danger) return c256(cfg.danger);
  if (pct > warning) return c256(cfg.warning);
  return c256(cfg.normal);
}

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "m";
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return String(n);
}

function buildBar(pct, color, dim, width = 20) {
  const filled = Math.round((width * pct) / 100);
  const empty = width - filled;
  return `${color}${"\u2588".repeat(filled)}${dim}${"\u2591".repeat(empty)}${RESET}`;
}

function accumulate(sessionTokens, sessionCost) {
  // when tokens drop a new session started so carry over old totals
  const state = loadJson(SESSION_PATH, {
    last_tokens: 0,
    last_cost: 0,
    carry_tokens: 0,
    carry_cost: 0,
  });

  let carryTokens = state.carry_tokens || 0;
  let carryCost = state.carry_cost || 0;
  const lastTokens = state.last_tokens || 0;
  const lastCost = state.last_cost || 0;

  if (sessionTokens < lastTokens) {
    carryTokens += lastTokens;
    carryCost += lastCost;
  }

  state.last_tokens = sessionTokens;
  state.last_cost = sessionCost;
  state.carry_tokens = carryTokens;
  state.carry_cost = carryCost;
  saveJson(SESSION_PATH, state);

  return [carryTokens + sessionTokens, carryCost + sessionCost];
}

// usage api

function getAccessToken() {
  const data = loadJson(CREDENTIALS_PATH, {});
  return (data.claudeAiOauth || {}).accessToken || null;
}

function fetchUsage(token) {
  return new Promise((resolve) => {
    const url = new URL(USAGE_API_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...USAGE_API_HEADERS,
      },
      timeout: API_TIMEOUT_SECONDS * 1000,
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(body);
          // reject responses that contain an error field
          if (parsed.error) {
            resolve(null);
            return;
          }
          resolve(parsed);
        } catch {
          resolve(null);
        }
      });
    });

    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

function readUsageCache() {
  const cache = loadJson(USAGE_CACHE_PATH, null);
  if (!cache || !cache.fetched_at || !cache.data) return [null, Infinity];
  const age = Date.now() / 1000 - cache.fetched_at;
  return [cache.data, age];
}

function writeUsageCache(data) {
  saveJson(USAGE_CACHE_PATH, { fetched_at: Date.now() / 1000, data });
  // persist last known good response for long term fallback
  saveJson(USAGE_GOOD_PATH, { fetched_at: Date.now() / 1000, data });
  // compute burn rate when fresh data arrives
  computeAndSaveVelocity(data);
}

function readLastGoodUsage() {
  const cache = loadJson(USAGE_GOOD_PATH, null);
  if (!cache || !cache.data) return null;
  return cache.data;
}

// velocity tracking - called only when fresh api data arrives (~every 2.5 min)
function computeAndSaveVelocity(usageData) {
  const prev = loadJson(VELOCITY_PATH, null);
  const now = Date.now() / 1000;

  const current = {};
  for (const [apiKey] of USAGE_BUCKETS) {
    const bucket = usageData[apiKey];
    if (bucket) current[apiKey] = bucket.utilization || 0;
  }

  const samples = (prev && prev.samples) ? prev.samples + 1 : 1;
  saveJson(VELOCITY_PATH, { ts: now, buckets: current, samples });

  // need previous data and at least 1 min elapsed
  if (!prev || !prev.ts || !prev.buckets) return;
  const elapsed = (now - prev.ts) / 60;
  if (elapsed < 1) return;

  const velocities = {};
  for (const [apiKey] of USAGE_BUCKETS) {
    const cur = current[apiKey];
    const old = prev.buckets[apiKey];
    if (cur != null && old != null && cur > old) {
      velocities[apiKey] = (cur - old) / elapsed;
    }
  }

  if (Object.keys(velocities).length > 0) {
    saveJson(VELOCITIES_PATH, { ts: now, samples, velocities });
  }
}

// reads pre-computed velocities, returns null if stale or too few samples
function getVelocities(maxAgeSec) {
  const data = loadJson(VELOCITIES_PATH, null);
  if (!data || !data.ts || !data.velocities) return null;
  if (Date.now() / 1000 - data.ts > (maxAgeSec || 600)) return null;
  if ((data.samples || 0) < 2) return null;
  return data.velocities;
}

function fmtEta(pct, velocity, maxHours) {
  if (!velocity || velocity <= 0) return null;
  const remaining = (100 - pct) / velocity;
  if (remaining <= 0 || remaining > maxHours * 60) return null;
  if (remaining >= 60) {
    const h = Math.floor(remaining / 60);
    const m = Math.round(remaining % 60);
    return m > 0 ? `~${h}h${m}m` : `~${h}h`;
  }
  return `~${Math.round(Math.max(1, remaining))}m`;
}

async function refreshUsage(staleData, staleAge) {
  // try api first, fall back to stale cache within grace period
  const token = getAccessToken();
  if (!token) {
    if (staleData && staleAge < CACHE_GRACE_SECONDS) return staleData;
    return null;
  }

  const fresh = await fetchUsage(token);
  if (fresh) {
    writeUsageCache(fresh);
    return fresh;
  }

  if (staleData && staleAge < CACHE_GRACE_SECONDS) return staleData;
  return null;
}

async function getUsageData(cfg) {
  // returns cached data instantly or refreshes asynchronously with a 2s timeout
  // falls back to last known good data if everything else fails
  if (!cfg.show_usage) return null;

  const ttl = cfg.cache_ttl || CACHE_TTL_SECONDS;
  const [cachedData, age] = readUsageCache();

  if (age < ttl) return cachedData;

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 2000));
  const refresh = refreshUsage(cachedData, age);
  const data = await Promise.race([refresh, timeout]);

  if (data) return data;
  if (cachedData && age < CACHE_GRACE_SECONDS) return cachedData;
  // all short term caches failed, use last known good response
  return readLastGoodUsage();
}

function fmtResetTime(resetsAtStr) {
  if (!resetsAtStr) return "";
  try {
    const resetDt = new Date(resetsAtStr);
    const now = new Date();
    const totalSeconds = Math.max(0, Math.floor((resetDt - now) / 1000));
    if (totalSeconds >= 3600) return `~${Math.floor(totalSeconds / 3600)}h`;
    if (totalSeconds >= 60) return `~${Math.floor(totalSeconds / 60)}m`;
    return `~${totalSeconds}s`;
  } catch {
    return "";
  }
}

function renderUsageLine(usageData, cfg) {
  if (!usageData) return null;

  const dim = c256(cfg.dim);
  const dot = ` ${dim}\u00b7${RESET} `;

  // show only the 5h bucket
  const bucket = usageData.five_hour;
  if (!bucket) return null;

  const pct = bucket.utilization || 0;
  const color = pickBarColor(pct, cfg);
  let line = ` ${dim}5h:${RESET}${color}${Math.round(pct)}%${RESET}`;

  if (cfg.show_resets) {
    const rst = fmtResetTime(bucket.resets_at);
    if (rst) line += `${dot}${dim}resets ${rst}${RESET}`;
  }

  return line;
}

function renderPredictionLine(usageData, cfg, velocities) {
  if (!usageData || !velocities || !cfg.show_predictions) return null;

  const bucket = usageData.five_hour;
  const velocity = velocities.five_hour;
  if (!bucket || !velocity) return null;

  const pct = bucket.utilization || 0;
  const dim = c256(cfg.dim);
  const teal = c256(37);
  const dot = ` ${dim}\u00b7${RESET} `;

  let line = ` ${dim}burn:${RESET} ${teal}${velocity.toFixed(1)}%/min${RESET}`;

  const eta = fmtEta(pct, velocity, cfg.prediction_horizon || 3);
  if (eta) {
    const remaining = (100 - pct) / velocity;
    let etaColor;
    if (remaining < 3) etaColor = c256(cfg.critical);
    else if (remaining < 10) etaColor = c256(cfg.danger);
    else etaColor = c256(cfg.warning);
    line += `${dot}${etaColor}cap ${eta}${RESET}`;
  } else {
    line += `${dot}${c256(70)}safe${RESET}`;
  }

  return line;
}

function findGitDir(startDir) {
  // walk up the directory tree to find .git, handles subdirectories
  let dir = startDir;
  const root = path.parse(dir).root;
  while (dir !== root) {
    const gitPath = path.join(dir, ".git");
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) return gitPath;
      // worktree: .git is a file containing "gitdir: <path>"
      if (stat.isFile()) {
        const content = fs.readFileSync(gitPath, "utf-8").trim();
        if (content.startsWith("gitdir: ")) return content.slice(8);
      }
    } catch {
      // not found at this level, keep walking up
    }
    dir = path.dirname(dir);
  }
  return null;
}

function getGitBranch() {
  // walks up from cwd to find .git, reads HEAD for branch name
  try {
    const gitDir = findGitDir(process.cwd());
    if (!gitDir) return null;
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf-8").trim();
    if (head.startsWith("ref: refs/heads/")) return head.slice(16);
    // detached head, show short hash so user knows they're not on a branch
    if (head.length >= 7) return "detached-" + head.slice(0, 7);
    return null;
  } catch {
    return null;
  }
}

// main render

async function render(data) {
  const cfg = loadConfig();
  const dim = c256(cfg.dim);
  const accent = c256(cfg.accent);
  const tokColor = c256(cfg.tokens);

  const ctx = data.context_window || {};
  const costInfo = data.cost || {};
  const modelInfo = data.model || {};

  const pct = ctx.used_percentage || 0;
  const windowSize = ctx.context_window_size || 0;
  const inputTok = ctx.total_input_tokens || 0;
  const outputTok = ctx.total_output_tokens || 0;
  const sessionTokens = inputTok + outputTok;
  const currentTok = Math.round((windowSize * pct) / 100);

  const sessionCost = costInfo.total_cost_usd || 0;

  const modelName = modelInfo.display_name || modelInfo.id || "?";
  const modelShort = modelName.replace("Claude ", "");

  const [lifetimeTokens, lifetimeCost] = accumulate(sessionTokens, sessionCost);

  const barColor = pickBarColor(pct, cfg);
  const bar = buildBar(pct, barColor, dim, cfg.bar_width);
  const dot = ` ${dim}\u00b7${RESET} `;

  // compact warning: show when approaching the configured compact threshold
  let compactTag = "";
  if (cfg.compact_enabled && cfg.compact_threshold > 0) {
    const ct = cfg.compact_threshold;
    if (pct >= ct) {
      // at or past threshold — urgent flash
      compactTag = ` ${c256(cfg.critical)}\u26a0 /compact${RESET}`;
    } else if (pct >= ct - 10) {
      // within 10% of threshold — early warning
      compactTag = ` ${c256(cfg.warning)}${dim}\u2192 compact@${ct}%${RESET}`;
    }
  }

  const line1 = ` ${bar} ${barColor}${Math.round(pct)}%${RESET}  ${tokColor}${fmtTokens(currentTok)}/${fmtTokens(windowSize)}${RESET}${compactTag}`;
  const branch = getGitBranch();
  const line2Parts = [
    ` ${dim}\u2191${RESET}${accent}${fmtTokens(inputTok)} ${dim}\u2193${RESET}${accent}${fmtTokens(outputTok)}`,
    `${accent}${modelShort}${RESET}`,
  ];
  if (branch) line2Parts.push(`${dim}@${branch}${RESET}`);
  const line2 = line2Parts.join(dot);

  const usageData = await getUsageData(cfg);
  const velocities = usageData ? getVelocities() : null;
  const line3 = renderUsageLine(usageData, cfg);
  const line4 = renderPredictionLine(usageData, cfg, velocities);

  const lines = [line1, line2];
  if (line3) lines.push(line3);
  if (line4) lines.push(line4);
  return lines.join("\n");
}

async function main() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf-8");
    const data = JSON.parse(raw);
    console.log(await render(data));
  } catch {
    console.log("");
  }
}

main();
