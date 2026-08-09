"use strict";

class SessionLifecycleRegistry {
  constructor() {
    this.disposals = new Map();
    this.tails = new Map();
  }

  trackDisposal(key, promise) {
    if (typeof key !== "string" || !key) return Promise.resolve(promise);
    const previous = this.disposals.get(key);
    const pending = previous ? [previous, Promise.resolve(promise)] : [Promise.resolve(promise)];
    const tracked = Promise.allSettled(pending).then((results) => {
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    }).finally(() => {
      if (this.disposals.get(key) === tracked) this.disposals.delete(key);
    });
    this.disposals.set(key, tracked);
    return tracked;
  }

  async waitForDisposal(key) {
    const pending = this.disposals.get(key);
    if (pending) await pending;
  }

  run(key, task) {
    if (typeof key !== "string" || !key) return Promise.resolve().then(task);
    const previous = this.tails.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    this.tails.set(key, tail);
    return run.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
  }
}

module.exports = { SessionLifecycleRegistry };
