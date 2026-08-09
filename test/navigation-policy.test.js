"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { classifyNavigation } = require("../lib/navigation-policy");

const localFile = path.join(path.parse(process.cwd()).root, "Prime Desktop Test", "index.html");

test("navigation classification keeps the app local and routes only http(s) externally", () => {
  assert.equal(classifyNavigation(pathToFileURL(localFile).href, localFile).action, "local");
  assert.equal(classifyNavigation("https://example.invalid/docs?q=1", localFile).action, "external");
  assert.equal(classifyNavigation("http://example.invalid/", localFile).action, "external");
  const allowed = pathToFileURL(localFile);
  for (const target of ["javascript:alert(1)", "data:text/html,boom", "file:///tmp/other.html", `file://remote-host${allowed.pathname}`, "ftp://example.invalid/a", "not a url"]) {
    assert.equal(classifyNavigation(target, localFile).action, "deny", target);
  }
});
