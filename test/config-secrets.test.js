"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { providerEntryPreservingSecret } = require("../lib/config-secrets");

test("redacted provider edits preserve secrets while explicit replacement and none revocation remain possible", () => {
  const existing = { apiKey: "synthetic-original-key" };
  assert.equal(providerEntryPreservingSecret({ baseUrl: "https://changed.invalid", hasApiKey: true }, existing).apiKey, "synthetic-original-key");
  assert.equal(providerEntryPreservingSecret({ apiKey: "" }, existing).apiKey, "synthetic-original-key");
  assert.equal(providerEntryPreservingSecret({ apiKey: "synthetic-replacement" }, existing).apiKey, "synthetic-replacement");
  assert.equal(providerEntryPreservingSecret({ apiKey: "none" }, existing).apiKey, "none");
  const fresh = providerEntryPreservingSecret({ baseUrl: "http://localhost" }, null);
  assert.equal(Object.hasOwn(fresh, "apiKey"), false);
  assert.equal(Object.hasOwn(fresh, "hasApiKey"), false);
});
