import io
import json
import os
import sys
import threading
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

# force utf-8 output on windows
if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


RESET = "\033[0m"
CHONKER_DIR = os.path.join(os.path.expanduser("~"), ".chonker")
CONFIG_PATH = os.path.join(CHONKER_DIR, "config.json")
SESSION_PATH = os.path.join(CHONKER_DIR, "session.json")
USAGE_CACHE_PATH = os.path.join(CHONKER_DIR, "usage.json")
CREDENTIALS_PATH = os.path.join(os.path.expanduser("~"), ".claude", ".credentials.json")

USAGE_API_URL = "https://api.anthropic.com/api/oauth/usage"
USAGE_API_HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": "claude-code/2.0.32",
    "anthropic-beta": "oauth-2025-04-20",
}

CACHE_TTL_SECONDS = 60
API_TIMEOUT_SECONDS = 3
CACHE_GRACE_SECONDS = 300

# 256 color ansi codes unless noted
DEFAULTS = {
    "accent": 208,
    "normal": 255,
    "warning": 208,
    "danger": 160,
    "critical": 196,
    "tokens": 80,
    "dim": 242,
    "bar_width": 20,
    "show_usage": True,
    "show_resets": False,
    "cache_ttl": 60,
}

# maps api response keys to display labels, null buckets are skipped
USAGE_BUCKETS = [
    ("five_hour", "5h"),
    ("seven_day", "7d"),
    ("seven_day_opus", "opus"),
    ("seven_day_sonnet", "sonnet"),
]


def load_json(path, fallback):
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, IOError):
        return fallback


def save_json(path, data):
    # atomic write via tmp file to prevent corruption on crash
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def load_config():
    return {**DEFAULTS, **load_json(CONFIG_PATH, {})}


def c256(n):
    return "\033[38;5;%dm" % n


def pick_bar_color(pct, cfg):
    if pct > 85:
        return c256(cfg["critical"])
    if pct > 70:
        return c256(cfg["danger"])
    if pct > 50:
        return c256(cfg["warning"])
    return c256(cfg["normal"])


def fmt_tokens(n):
    if n >= 1_000_000:
        return "%.1fm" % (n / 1_000_000)
    if n >= 1_000:
        return "%.0fk" % (n / 1_000)
    return str(n)


def build_bar(pct, color, dim, width=20):
    filled = round(width * pct / 100)
    empty = width - filled
    return "%s%s%s%s%s" % (color, "\u2588" * filled, dim, "\u2591" * empty, RESET)


def accumulate(session_tokens, session_cost):
    # when tokens drop a new session started so carry over old totals
    state = load_json(
        SESSION_PATH,
        {
            "last_tokens": 0,
            "last_cost": 0.0,
            "carry_tokens": 0,
            "carry_cost": 0.0,
        },
    )

    carry_tokens = state.get("carry_tokens", 0)
    carry_cost = state.get("carry_cost", 0.0)
    last_tokens = state.get("last_tokens", 0)
    last_cost = state.get("last_cost", 0.0)

    if session_tokens < last_tokens:
        carry_tokens += last_tokens
        carry_cost += last_cost

    state["last_tokens"] = session_tokens
    state["last_cost"] = session_cost
    state["carry_tokens"] = carry_tokens
    state["carry_cost"] = carry_cost
    save_json(SESSION_PATH, state)

    return carry_tokens + session_tokens, carry_cost + session_cost


# usage api

def get_access_token():
    data = load_json(CREDENTIALS_PATH, {})
    return data.get("claudeAiOauth", {}).get("accessToken")


def fetch_usage(token):
    req = urllib.request.Request(USAGE_API_URL)
    req.add_header("Authorization", "Bearer %s" % token)
    for k, v in USAGE_API_HEADERS.items():
        req.add_header(k, v)
    try:
        resp = urllib.request.urlopen(req, timeout=API_TIMEOUT_SECONDS)
        return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError,
            OSError, ValueError):
        return None


def read_usage_cache():
    cache = load_json(USAGE_CACHE_PATH, None)
    if cache is None or "fetched_at" not in cache or "data" not in cache:
        return None, float("inf")
    age = time.time() - cache["fetched_at"]
    return cache["data"], age


def write_usage_cache(data):
    save_json(USAGE_CACHE_PATH, {"fetched_at": time.time(), "data": data})


def refresh_usage(stale_data, stale_age):
    # try api first, fall back to stale cache within grace period
    token = get_access_token()
    if token is None:
        if stale_data is not None and stale_age < CACHE_GRACE_SECONDS:
            return stale_data
        return None

    fresh = fetch_usage(token)
    if fresh is not None:
        write_usage_cache(fresh)
        return fresh

    if stale_data is not None and stale_age < CACHE_GRACE_SECONDS:
        return stale_data
    return None


def get_usage_data(cfg):
    # returns cached data instantly or refreshes in a background thread with 2s timeout
    if not cfg.get("show_usage", True):
        return None

    ttl = cfg.get("cache_ttl", CACHE_TTL_SECONDS)
    cached_data, age = read_usage_cache()

    if age < ttl:
        return cached_data

    result = [cached_data]

    def _refresh():
        result[0] = refresh_usage(cached_data, age)

    t = threading.Thread(target=_refresh, daemon=True)
    t.start()
    t.join(timeout=2.0)

    data = result[0]
    if data is None and cached_data is not None and age < CACHE_GRACE_SECONDS:
        return cached_data
    return data


def fmt_reset_time(resets_at_str):
    if not resets_at_str:
        return ""
    try:
        reset_dt = datetime.fromisoformat(resets_at_str)
        if reset_dt.tzinfo is None:
            reset_dt = reset_dt.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        total_seconds = max(0, int((reset_dt - now).total_seconds()))
        if total_seconds >= 3600:
            return "~%dh" % (total_seconds // 3600)
        if total_seconds >= 60:
            return "~%dm" % (total_seconds // 60)
        return "~%ds" % total_seconds
    except (ValueError, TypeError, OverflowError):
        return ""


def render_usage_line(usage_data, cfg):
    if usage_data is None:
        return None

    dim = c256(cfg["dim"])
    show_resets = cfg.get("show_resets", False)
    dot = " %s\u00b7%s " % (dim, RESET)
    segments = []

    for api_key, label in USAGE_BUCKETS:
        bucket = usage_data.get(api_key)
        if bucket is None:
            continue
        pct = bucket.get("utilization", 0)
        color = pick_bar_color(pct, cfg)
        seg = "%s%s:%s%s%.0f%%%s" % (dim, label, RESET, color, pct, RESET)
        if show_resets:
            rst = fmt_reset_time(bucket.get("resets_at"))
            if rst:
                seg += " %s%s%s" % (dim, rst, RESET)
        segments.append(seg)

    # extra usage has a different structure with is_enabled and monthly_limit
    extra = usage_data.get("extra_usage")
    if extra is not None and extra.get("is_enabled"):
        pct = extra.get("utilization", 0)
        color = pick_bar_color(pct, cfg)
        segments.append("%s%s:%s%s%.0f%%%s" % (dim, "xtra", RESET, color, pct, RESET))

    if not segments:
        return None
    return " " + dot.join(segments)


# main render

def render(data):
    cfg = load_config()
    dim = c256(cfg["dim"])
    accent = c256(cfg["accent"])
    tok_color = c256(cfg["tokens"])

    ctx = data.get("context_window", {})
    cost_info = data.get("cost", {})
    model_info = data.get("model", {})

    pct = ctx.get("used_percentage", 0)
    window_size = ctx.get("context_window_size", 0)
    input_tok = ctx.get("total_input_tokens", 0)
    output_tok = ctx.get("total_output_tokens", 0)
    session_tokens = input_tok + output_tok
    current_tok = round(window_size * pct / 100)

    session_cost = cost_info.get("total_cost_usd", 0)

    model_name = model_info.get("display_name", model_info.get("id", "?"))
    model_short = model_name.replace("Claude ", "")

    lifetime_tokens, lifetime_cost = accumulate(session_tokens, session_cost)

    bar_color = pick_bar_color(pct, cfg)
    bar = build_bar(pct, bar_color, dim, cfg["bar_width"])
    dot = " %s\u00b7%s " % (dim, RESET)

    line1 = " %s %s%.0f%%%s  %s%s/%s%s" % (
        bar,
        bar_color,
        pct,
        RESET,
        tok_color,
        fmt_tokens(current_tok),
        fmt_tokens(window_size),
        RESET,
    )
    line2 = dot.join(
        [
            " %s\u2191%s%s%s %s\u2193%s%s%s"
            % (
                dim,
                RESET,
                accent,
                fmt_tokens(input_tok),
                dim,
                RESET,
                accent,
                fmt_tokens(output_tok),
            ),
            "%s%s%s" % (accent, model_short, RESET),
        ]
    )

    usage_data = get_usage_data(cfg)
    line3 = render_usage_line(usage_data, cfg)

    if line3 is not None:
        return "%s\n%s\n%s" % (line1, line2, line3)
    return "%s\n%s" % (line1, line2)


def main():
    try:
        raw = sys.stdin.read()
        data = json.loads(raw)
        print(render(data))
    except Exception:
        print("")


if __name__ == "__main__":
    main()
