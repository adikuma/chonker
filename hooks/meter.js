const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

const RESET = "\x1b[0m";
const CHONKER_DIR = path.join(os.homedir(), ".chonker");
const CONFIG_PATH = path.join(CHONKER_DIR, "config.json");
const SESSION_PATH = path.join(CHONKER_DIR, "session.json");
const USAGE_CACHE_PATH = path.join(CHONKER_DIR, "usage.json");
const CREDENTIALS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");

const USAGE_API_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_API_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "claude-code/2.0.32",
  "anthropic-beta": "oauth-2025-04-20",
};

const CACHE_TTL_SECONDS = 60;
const API_TIMEOUT_SECONDS = 3;
const CACHE_GRACE_SECONDS = 300;

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
  show_resets: false,
  cache_ttl: 60,
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
  if (pct > 85) return c256(cfg.critical);
  if (pct > 70) return c256(cfg.danger);
  if (pct > 50) return c256(cfg.warning);
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
        try {
          resolve(JSON.parse(body));
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
  if (!cfg.show_usage) return null;

  const ttl = cfg.cache_ttl || CACHE_TTL_SECONDS;
  const [cachedData, age] = readUsageCache();

  if (age < ttl) return cachedData;

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 2000));
  const refresh = refreshUsage(cachedData, age);
  const data = await Promise.race([refresh, timeout]);

  if (!data && cachedData && age < CACHE_GRACE_SECONDS) return cachedData;
  return data;
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
  const showResets = cfg.show_resets || false;
  const dot = ` ${dim}\u00b7${RESET} `;
  const segments = [];

  for (const [apiKey, label] of USAGE_BUCKETS) {
    const bucket = usageData[apiKey];
    if (!bucket) continue;
    const pct = bucket.utilization || 0;
    const color = pickBarColor(pct, cfg);
    let seg = `${dim}${label}:${RESET}${color}${Math.round(pct)}%${RESET}`;
    if (showResets) {
      const rst = fmtResetTime(bucket.resets_at);
      if (rst) seg += ` ${dim}${rst}${RESET}`;
    }
    segments.push(seg);
  }

  // extra usage has a different structure with is_enabled and monthly_limit
  const extra = usageData.extra_usage;
  if (extra && extra.is_enabled) {
    const pct = extra.utilization || 0;
    const color = pickBarColor(pct, cfg);
    segments.push(`${dim}xtra:${RESET}${color}${Math.round(pct)}%${RESET}`);
  }

  if (!segments.length) return null;
  return " " + segments.join(dot);
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

  const line1 = ` ${bar} ${barColor}${Math.round(pct)}%${RESET}  ${tokColor}${fmtTokens(currentTok)}/${fmtTokens(windowSize)}${RESET}`;
  const line2 = [
    ` ${dim}\u2191${RESET}${accent}${fmtTokens(inputTok)} ${dim}\u2193${RESET}${accent}${fmtTokens(outputTok)}`,
    `${accent}${modelShort}${RESET}`,
  ].join(dot);

  const usageData = await getUsageData(cfg);
  const line3 = renderUsageLine(usageData, cfg);

  if (line3) return `${line1}\n${line2}\n${line3}`;
  return `${line1}\n${line2}`;
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
