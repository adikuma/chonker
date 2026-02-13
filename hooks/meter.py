import io
import json
import os
import sys

# force utf-8 output on windows
if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


RESET = "\033[0m"
CHONKER_DIR = os.path.join(os.path.expanduser("~"), ".chonker")
CONFIG_PATH = os.path.join(CHONKER_DIR, "config.json")
SESSION_PATH = os.path.join(CHONKER_DIR, "session.json")

DEFAULTS = {
    "accent": 208,
    "normal": 255,
    "warning": 208,
    "danger": 160,
    "critical": 196,
    "tokens": 80,
    "dim": 242,
    "bar_width": 20,
}


def load_json(path, fallback):
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, IOError):
        return fallback


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f)


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
