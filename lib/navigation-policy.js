"use strict";

const { pathToFileURL } = require("url");

function classifyNavigation(target, localFile) {
  let parsed;
  let allowed;
  try {
    parsed = new URL(String(target || ""));
    allowed = pathToFileURL(localFile);
  } catch { return { action: "deny", url: null }; }
  if (parsed.protocol === "file:" && parsed.host === allowed.host && parsed.pathname === allowed.pathname) {
    return { action: "local", url: parsed.href };
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return { action: "external", url: parsed.href };
  }
  return { action: "deny", url: null };
}

module.exports = { classifyNavigation };
