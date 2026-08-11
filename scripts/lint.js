#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const skip = new Set(["node_modules", "dist", ".git", ".worktrees"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const files = walk(root);
let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    failed += 1;
    const msg = error.stderr ? error.stderr.toString() : String(error);
    console.error(`FAIL  ${path.relative(root, file)}\n${msg}`);
  }
}

if (failed) {
  console.error(`\nLint failed: ${failed} file(s)`);
  process.exit(1);
}
console.log(`Lint OK — ${files.length} JavaScript files syntax-checked`);
