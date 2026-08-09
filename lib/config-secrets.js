"use strict";

function providerEntryPreservingSecret(raw, existing = null) {
  const entry = { ...raw };
  delete entry.hasApiKey;
  delete entry.apiKeyMasked;
  if (entry.apiKey == null || entry.apiKey === "") {
    if (existing && typeof existing.apiKey === "string") entry.apiKey = existing.apiKey;
    else delete entry.apiKey;
  }
  return entry;
}

module.exports = { providerEntryPreservingSecret };
