import sys
import json


GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
BRIGHT_RED = "\033[91m"
RESET = "\033[0m"


def pick_color(pct):
    if pct > 90:
        return BRIGHT_RED
    if pct > 80:
        return RED
    if pct > 60:
        return YELLOW
    return GREEN


def format_tokens(n):
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}m"
    if n >= 1_000:
        return f"{n / 1_000:.0f}k"
    return str(n)


def format_duration(ms):
    total_seconds = int(ms / 1000)
    minutes = total_seconds // 60
    seconds = total_seconds % 60
    if minutes > 0:
        return f"{minutes}m {seconds:02d}s"
    return f"{seconds}s"


def build_bar(pct, width=10):
    filled = round(width * pct / 100)
    empty = width - filled
    return "\u2593" * filled + "\u2591" * empty


def render(data):
    ctx = data.get("context_window", {})
    cost_info = data.get("cost", {})
    model_info = data.get("model", {})

    pct = ctx.get("used_percentage", 0)
    total = ctx.get("context_window_size", 0)
    input_tokens = ctx.get("total_input_tokens", 0)
    output_tokens = ctx.get("total_output_tokens", 0)
    used_tokens = input_tokens + output_tokens

    cost_usd = cost_info.get("total_cost_usd", 0)
    duration_ms = cost_info.get("total_duration_ms", 0)

    model_name = model_info.get("display_name", model_info.get("id", "?"))

    color = pick_color(pct)
    bar = build_bar(pct)

    parts = [
        f"[{model_name}]",
        f"{color}{bar} {pct:.0f}%{RESET}",
        f"{format_tokens(used_tokens)}/{format_tokens(total)} tokens",
        f"${cost_usd:.2f}",
        format_duration(duration_ms),
    ]

    return " | ".join(parts)


def main():
    try:
        raw = sys.stdin.read()
        data = json.loads(raw)
        print(render(data))
    except Exception:
        # graceful fallback on bad input
        print("")


if __name__ == "__main__":
    main()
