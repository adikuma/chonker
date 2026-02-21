#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");

const CHONKER_DIR = path.join(os.homedir(), ".chonker");
const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const METER_SRC = path.join(__dirname, "..", "hooks", "meter.js");
const METER_DEST = path.join(CHONKER_DIR, "meter.js");

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

function main() {
  // copy meter.js to ~/.chonker/ so it persists after npx cleans up
  fs.mkdirSync(CHONKER_DIR, { recursive: true });
  fs.copyFileSync(METER_SRC, METER_DEST);

  // configure claude code status line
  const settings = loadSettings();
  const command = `"${process.execPath}" "${METER_DEST}"`;

  settings.statusLine = {
    type: "command",
    command,
    refreshInterval: REFRESH_INTERVAL,
  };
  saveSettings(settings);

  console.log("");
  console.log("  chonker installed");
  console.log("");
  console.log("  meter copied to ~/.chonker/meter.js");
  console.log("  status line configured in ~/.claude/settings.json");
  console.log("");
  console.log("  restart claude code to see the meter");
  console.log("");
}

main();
