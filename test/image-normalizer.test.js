"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AttachmentError, sniffImageMime } = require("../lib/attachment-service");
const { convertGifOrWebpWithSips, createElectronImageNormalizer } = require("../lib/electron-image-normalizer");

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

function tempArtifacts() {
  return new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("prime-desktop-image-")));
}

function runElectronFixture() {
  return new Promise((resolve, reject) => {
    const electron = require("electron");
    const isolation = fs.mkdtempSync(path.join(os.tmpdir(), "prime-image-electron-test-"));
    const home = path.join(isolation, "home");
    const tmp = path.join(isolation, "tmp");
    const userData = path.join(isolation, "user-data");
    fs.mkdirSync(home); fs.mkdirSync(tmp); fs.mkdirSync(userData);
    const child = spawn(electron, [path.join(__dirname, "..", "scripts", "image-normalize-fixture.js")], {
      cwd: path.join(__dirname, ".."),
      detached: true,
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: home,
        USER: "prime-image-test",
        LOGNAME: "prime-image-test",
        TMPDIR: tmp,
        PRIME_IMAGE_TEST_USER_DATA: userData,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = ""; let settled = false; let timer = null;
    const cleanup = () => fs.rmSync(isolation, { recursive: true, force: true });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (error) reject(error); else resolve(value);
    };
    const killTree = () => {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch { try { child.kill("SIGKILL"); } catch {} }
    };
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(error));
    timer = setTimeout(() => { killTree(); finish(new Error("Electron image fixture timed out")); }, 20_000);
    child.on("exit", (code) => {
      if (code !== 0) return finish(new Error(stderr || `Electron exited ${code}`));
      const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("IMAGE_NORMALIZER_RESULT "));
      if (!line) return finish(new Error(`Missing image result: ${stdout} ${stderr}`));
      try { finish(null, JSON.parse(line.slice("IMAGE_NORMALIZER_RESULT ".length))); }
      catch (error) { finish(error); }
    });
  });
}

test("production Electron normalizer covers valid, malformed, and animated PNG/JPEG/GIF/WebP", { skip: process.platform !== "darwin" }, async () => {
  const proof = await runElectronFixture();
  for (const name of ["png", "jpeg", "gif", "animatedGif", "webp"]) {
    assert.ok(proof.results[name].width >= 1 && proof.results[name].height >= 1, name);
    assert.equal(proof.results[name].preview, true, name);
    assert.equal(proof.results[name].underCap, true, name);
    assert.equal(proof.results[name].outputMime, proof.results[name].outputSniff, name);
  }
  assert.equal(proof.results.gif.outputMime, "image/png");
  assert.equal(proof.results.webp.outputMime, "image/png");
  assert.equal(proof.animatedFrames, 2, "the source fixture is actually animated");
  assert.equal(proof.results.animatedGif.outputMime, "image/png", "animation is normalized to one PNG frame");
  assert.deepEqual(proof.malformed, { png: true, jpeg: true, gif: true, webp: true });
});

test("production normalizer enforces the final RPC base64 cap", async () => {
  const encoded = Buffer.alloc(128, 0x41);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(encoded);
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 1, height: 1 }),
    resize: () => image,
    toPNG: () => encoded,
    toJPEG: () => encoded,
  };
  const normalize = createElectronImageNormalizer({
    nativeImage: { createFromBuffer: () => image },
    AttachmentError,
    sniffImageMime,
  });
  const source = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const sourceBase64Length = source.toString("base64").length;
  const accepted = await normalize({ buffer: source, mimeType: "image/png", dimensions: { width: 1, height: 1 }, maxDimension: 1568, maxBase64: sourceBase64Length + 1 });
  assert.equal(accepted.buffer.toString("base64").length, sourceBase64Length, "a payload just under the cap succeeds");
  await assert.rejects(normalize({ buffer: source, mimeType: "image/png", dimensions: { width: 1, height: 1 }, maxDimension: 1568, maxBase64: 64 }), (error) => error && error.code === "IMAGE_NORMALIZE_LIMIT");
});

test("sips conversion fails closed on malformed input and always removes its temp directory", { skip: process.platform !== "darwin" }, async () => {
  const before = tempArtifacts();
  await assert.rejects(convertGifOrWebpWithSips({ buffer: Buffer.from("GIF89a malformed"), mimeType: "image/gif", dimensions: { width: 2, height: 2 }, maxDimension: 1568 }));
  const after = tempArtifacts();
  assert.deepEqual(after, before);
});

test("sips conversion enforces private modes, output cap, and cleanup", async () => {
  const before = tempArtifacts();
  let observed = null;
  const fakeExec = async (_command, args) => {
    const input = args.at(-3);
    const output = args.at(-1);
    observed = {
      directoryMode: fs.statSync(path.dirname(input)).mode & 0o777,
      inputMode: fs.statSync(input).mode & 0o777,
    };
    fs.writeFileSync(output, Buffer.alloc(20_000_001), { mode: 0o600 });
  };
  await assert.rejects(convertGifOrWebpWithSips({ buffer: GIF, mimeType: "image/gif", dimensions: { width: 1, height: 1 }, maxDimension: 1568, runExecFile: fakeExec }), /invalid/);
  assert.deepEqual(observed, { directoryMode: 0o700, inputMode: 0o600 });
  assert.deepEqual(tempArtifacts(), before);
});
