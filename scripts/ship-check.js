#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function run(label, command, args) {
  process.stdout.write(`\n==> ${label}\n`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    console.error(`\nSHIP CHECK FAIL at: ${label}`);
    process.exit(result.status || 1);
  }
}

console.log(`Prime Desktop ship-check v${pkg.version}`);
console.log(`Repo: ${root}`);

// Required docs for a public ship
for (const rel of [
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "docs/INSTALL.md",
  "docs/KNOWN_LIMITS.md",
  "docs/SHIP.md",
  "docs/TROUBLESHOOTING.md",
]) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    console.error(`Missing required ship file: ${rel}`);
    process.exit(1);
  }
  process.stdout.write(`OK  ${rel}\n`);
}

run("lint", process.execPath, [path.join("scripts", "lint.js")]);
run("unit tests", process.execPath, ["--test", ...fs.readdirSync(path.join(root, "test")).filter((f) => f.endsWith(".test.js")).map((f) => path.join("test", f))]);
run("doctor", process.execPath, [path.join("scripts", "doctor.js")]);
run("smoke", process.execPath, [path.join("scripts", "smoke.js")]);

// ui-smoke is slower but required before marketing a desktop UI
run("ui-smoke", process.execPath, [path.join("scripts", "ui-smoke.js")]);
run("window-smoke", process.execPath, [path.join("scripts", "window-smoke.js")]);

console.log(`\nSHIP CHECK PASS — Prime Desktop v${pkg.version}`);
console.log("Next: manual 15-minute checklist in docs/SHIP.md, then publish/tag if needed.");
