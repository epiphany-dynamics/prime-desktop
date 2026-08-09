#!/usr/bin/env node
"use strict";

const { app, nativeImage } = require("electron");
const { AttachmentError, sniffImageMime, imageDimensions } = require("../lib/attachment-service");
const { createElectronImageNormalizer } = require("../lib/electron-image-normalizer");

if (process.env.PRIME_IMAGE_TEST_USER_DATA) app.setPath("userData", process.env.PRIME_IMAGE_TEST_USER_DATA);

const fixtures = {
  png: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  jpeg: Buffer.from("/9j//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABnAAEBAAAAAAAAAAAAAAAAAAADBwEBAQEAAAAAAAAAAAAAAAAAAgQHEAACAgICAwEAAAAAAAAAAAACAQMFBgQAEXa0NwcRAAICAgIBBQEBAAAAAAAAAAMCAQQFBgAHEbV2snMiNzT/wAARCAACAAIDARIAAhIAAxIA/9oADAMBAAIRAxEAPwChYBVVc+CYpLLo6csklDTnJIevEZmZaMLIiIgbIib7bb7b4/538/xHx6l9CDmQ9nmLS7K3arVI9YANmzwQAC0iCEQ8lYVBjGkwiIixCoixELEeIjh7Y/qe+e6th9Us8a6/gcgsXLmJxtu1ZiLFmzYp1zHsGL+yGMUg2chCPMs7vMszTMzPnllH/FW+gXwjn//Z", "base64"),
  gif: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
  animatedGif: Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAAh+QQBAAAAACwAAAAAAQABAAACAUwAOw==", "base64"),
  webp: Buffer.from("UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAgA0JaACdLoB+AADsAD+8Oj3/yC5YXXI1/8gP+MqfGVP+PIAAAA=", "base64"),
};

app.whenReady().then(async () => {
  const normalize = createElectronImageNormalizer({ nativeImage, AttachmentError, sniffImageMime });
  const results = {};
  for (const [name, buffer] of Object.entries(fixtures)) {
    const mimeType = sniffImageMime(buffer);
    const normalized = await normalize({ buffer, mimeType, dimensions: imageDimensions(buffer, mimeType), maxDimension: 1568, maxBase64: Math.floor(4.5 * 1024 * 1024) });
    results[name] = {
      sourceMime: mimeType,
      outputMime: normalized.mimeType,
      outputSniff: sniffImageMime(normalized.buffer),
      width: normalized.width,
      height: normalized.height,
      preview: normalized.previewBuffer.length > 0,
      underCap: normalized.buffer.toString("base64").length < Math.floor(4.5 * 1024 * 1024),
    };
  }
  const malformed = {};
  const badPng = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(badPng);
  badPng.write("IHDR", 12); badPng.writeUInt32BE(1, 16); badPng.writeUInt32BE(1, 20);
  const badJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0, 0x02, 0x11, 0, 0x03, 0x11, 0]);
  const badGif = Buffer.from("GIF89a\x01\x00\x01\x00", "binary");
  const badWebp = fixtures.webp.subarray(0, 30);
  for (const [name, buffer] of Object.entries({ png: badPng, jpeg: badJpeg, gif: badGif, webp: badWebp })) {
    const mimeType = sniffImageMime(buffer);
    try {
      await normalize({ buffer, mimeType, dimensions: imageDimensions(buffer, mimeType), maxDimension: 1568, maxBase64: Math.floor(4.5 * 1024 * 1024) });
      malformed[name] = false;
    } catch { malformed[name] = true; }
  }
  const animatedFrames = [...fixtures.animatedGif.keys()].filter((index) => fixtures.animatedGif[index] === 0x21 && fixtures.animatedGif[index + 1] === 0xf9 && fixtures.animatedGif[index + 2] === 0x04).length;
  console.log("IMAGE_NORMALIZER_RESULT", JSON.stringify({ results, malformed, animatedFrames }));
  app.exit(0);
}).catch((error) => {
  console.error("IMAGE_NORMALIZER_ERROR", error && error.stack || error);
  app.exit(1);
});
