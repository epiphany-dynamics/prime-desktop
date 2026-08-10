#!/usr/bin/env node
"use strict";

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const lines = [];
let failed = 0;

function ok(msg) { lines.push(`PASS  ${msg}`); }
function bad(msg) { failed += 1; lines.push(`FAIL  ${msg}`); }
function info(msg) { lines.push(`INFO  ${msg}`); }

function canRun(cmd) {
  try {
    execSync(cmd, { stdio: "ignore", timeout: 8000, env: process.env });
    return true;
  } catch {
    return false;
  }
}

function which(bin) {
  try {
    return execSync(`which ${bin}`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

console.log("Prime Desktop doctor\n");

// Node
const nodeVersion = process.versions.node;
const major = Number(nodeVersion.split(".")[0]);
if (major >= 20) ok(`Node.js ${nodeVersion}`);
else bad(`Node.js ${nodeVersion} (need 20+)`);

// Platform
if (process.platform === "darwin") ok(`Platform macOS (${os.arch()})`);
else bad(`Platform ${process.platform} (Desktop is macOS-first)`);

// Repo bits
const root = path.join(__dirname, "..");
for (const rel of ["main.js", "package.json", "renderer/index.html", "preload.js"]) {
  if (fs.existsSync(path.join(root, rel))) ok(`found ${rel}`);
  else bad(`missing ${rel}`);
}

// electron
const electronPath = path.join(root, "node_modules", "electron");
if (fs.existsSync(electronPath)) ok("electron is installed (node_modules)");
else bad("electron missing — run npm install");

// prime-agent discovery (same idea as main.js)
const home = os.homedir();
const candidates = [
  path.join(home, ".local", "bin", "prime-agent"),
  path.join(home, ".local", "lib", "node_modules", "prime-agent", "dist", "bundle", "cli.js"),
  path.join(home, ".hermes", "node", "bin", "prime-agent"),
  "/usr/local/bin/prime-agent",
  "/opt/homebrew/bin/prime-agent",
  which("prime-agent"),
].filter(Boolean);

const found = [...new Set(candidates)].find((p) => {
  try { return fs.existsSync(p); } catch { return false; }
});

if (found) {
  ok(`prime-agent found at ${found}`);
  let versionLabel = "";
  for (const args of [["--version"], ["version"], ["-V"]]) {
    try {
      const r = spawnSync(found, args, { encoding: "utf8", timeout: 8000 });
      const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
      if (out) { versionLabel = out.split("\n")[0].trim(); break; }
    } catch {}
  }
  if (versionLabel) info(`prime-agent version: ${versionLabel}`);
  else info("prime-agent found (version string unavailable)");
} else {
  bad("prime-agent not found");
  info("Install: curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh");
}

// npm scripts sanity
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
for (const s of ["start", "test", "smoke", "ui-smoke", "pack"]) {
  if (pkg.scripts && pkg.scripts[s]) ok(`npm script ${s}`);
  else bad(`npm script ${s} missing`);
}

console.log(lines.join("\n"));
console.log(failed ? `\nDoctor found ${failed} problem(s).` : "\nDoctor looks good.");
console.log("Next: npm start   or   see docs/INSTALL.md");
process.exit(failed ? 1 : 0);
