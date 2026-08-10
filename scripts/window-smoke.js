#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-desktop-window-smoke-"));
const home = path.join(base, "home");
fs.mkdirSync(path.join(home, ".prime", "agent", "sessions"), { recursive: true });
const electron = require("electron");
const env = {
  PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: home,
  USER: "prime-desktop-window-smoke",
  LOGNAME: "prime-desktop-window-smoke",
  SHELL: "/bin/zsh",
  TMPDIR: process.env.TMPDIR || os.tmpdir(),
  LANG: process.env.LANG || "en_US.UTF-8",
  PRIME_DESKTOP_TEST_MODE: "1",
  PRIME_DESKTOP_TEST_HOME: home,
  PRIME_DESKTOP_AGENT_SCRIPT: path.join(__dirname, "fake-agent.js"),
  PRIME_DESKTOP_TEST_SHORTCUT_FAILURE: "1",
  PRIME_DESKTOP_TEST_SHOW_WINDOWS: "1",
  PRIME_DESKTOP_WINDOW_LIFECYCLE_SMOKE: "1",
  ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
};
const child = spawn(electron, [path.join(__dirname, "..")], {
  cwd: path.join(__dirname, ".."), env, stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "", stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  try {
    const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("WINDOW_SMOKE_RESULT "));
    if (code !== 0 || !line) throw new Error(`Window smoke failed (code ${code}, signal ${signal || "none"})${stderr ? `: ${stderr.slice(-2000)}` : ""}`);
    const result = JSON.parse(line.slice("WINDOW_SMOKE_RESULT ".length));
    const required = ["opened", "mainVisible", "hudSeparate", "hudAlwaysOnTop", "menuFallback", "closed", "hiddenHudSurvived", "reactivated", "replacementVisible"];
    if (!required.every((key) => result[key] === true) || result.mainWindowCount !== 1 || result.shortcutRegistered !== false) {
      throw new Error("Window smoke assertions failed: " + JSON.stringify(result));
    }
    console.log("WINDOW-SMOKE startup HUD queue + menu fallback: PASS");
    console.log("WINDOW-SMOKE hidden HUD + Dock reactivation: PASS");
  } catch (error) {
    console.error(error.message);
    if (stdout) console.error(stdout.slice(-3000));
    process.exitCode = 1;
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
