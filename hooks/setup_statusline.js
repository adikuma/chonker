const fs = require("fs");
const path = require("path");
const os = require("os");

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

// absolute path to meter.js next to this script
const METER_PATH = path.join(__dirname, "meter.js");

const REFRESH_INTERVAL = 5000;

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

function desiredCommand() {
  return `"${process.execPath}" "${METER_PATH}"`;
}

function needsUpdate(settings) {
  const sl = settings.statusLine || {};
  return sl.command !== desiredCommand();
}

function main() {
  const settings = loadSettings();

  if (!needsUpdate(settings)) {
    // already configured, nothing to do
    console.log(
      JSON.stringify({
        additionalContext: "chonker context meter is active on status line",
      })
    );
    return;
  }

  settings.statusLine = {
    type: "command",
    command: desiredCommand(),
    refreshInterval: REFRESH_INTERVAL,
  };
  saveSettings(settings);

  console.log(
    JSON.stringify({
      additionalContext:
        "chonker context meter installed and active on status line",
    })
  );
}

main();
