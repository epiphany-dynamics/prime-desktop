"use strict";

function tryAcquireFlag(owner, key) {
  if (!owner || (typeof owner !== "object" && typeof owner !== "function") || typeof key !== "string" || !key) {
    throw new TypeError("A lock owner and key are required");
  }
  if (owner[key]) return null;
  owner[key] = true;
  let released = false;
  return function release() {
    if (released) return false;
    released = true;
    owner[key] = false;
    return true;
  };
}

module.exports = { tryAcquireFlag };
