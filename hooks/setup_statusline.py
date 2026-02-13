import json
import os
import sys

SETTINGS_PATH = os.path.join(os.path.expanduser("~"), ".claude", "settings.json")

# absolute path to meter.py next to this script
METER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "meter.py")

REFRESH_INTERVAL = 5000


def load_settings():
    if not os.path.exists(SETTINGS_PATH):
        return {}
    try:
        with open(SETTINGS_PATH, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}


def save_settings(settings):
    os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
    with open(SETTINGS_PATH, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")


def desired_command():
    return f'python "{METER_PATH}"'


def needs_update(settings):
    sl = settings.get("statusLine", {})
    return sl.get("command") != desired_command()


def main():
    settings = load_settings()

    if not needs_update(settings):
        # already configured, nothing to do
        result = {"additionalContext": "chonker context meter is active on status line"}
        print(json.dumps(result))
        return

    settings["statusLine"] = {
        "type": "command",
        "command": desired_command(),
        "refreshInterval": REFRESH_INTERVAL,
    }
    save_settings(settings)

    result = {
        "additionalContext": "chonker context meter installed and active on status line"
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
