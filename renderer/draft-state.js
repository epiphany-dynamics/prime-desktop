(function attachDraftState(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PrimeDraftState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function factory() {
  "use strict";

  function sameBinding(left, right) {
    return !!left && !!right
      && typeof left.key === "string" && left.key.length > 0 && left.key === right.key
      && typeof left.paneId === "string" && left.paneId.length > 0 && left.paneId === right.paneId
      && typeof left.bindingEpoch === "string" && left.bindingEpoch.length > 0 && left.bindingEpoch === right.bindingEpoch;
  }

  class DraftState {
    constructor() {
      this.id = null;
      this.workspaceGeneration = 0;
      this.revision = 0;
      this.items = [];
      this.error = null;
      this.pending = new Set();
      this.sending = false;
    }

    reset(descriptor) {
      this.id = descriptor && descriptor.id || null;
      this.workspaceGeneration = descriptor && descriptor.workspaceGeneration || 0;
      this.revision = descriptor && Number.isSafeInteger(descriptor.revision) ? descriptor.revision : 0;
      this.items = descriptor && Array.isArray(descriptor.items) ? [...descriptor.items] : [];
      this.error = null;
      this.pending.clear();
      this.sending = false;
      return this.snapshot();
    }

    beginIngest() {
      const token = `${this.id || "none"}:${Date.now()}:${Math.random()}`;
      this.pending.add(token);
      return { token, draftId: this.id, workspaceGeneration: this.workspaceGeneration };
    }

    applySnapshot(descriptor) {
      if (!descriptor || descriptor.id !== this.id || descriptor.workspaceGeneration !== this.workspaceGeneration) return false;
      const nextRevision = Number.isSafeInteger(descriptor.revision) ? descriptor.revision : 0;
      if (nextRevision < this.revision) return false;
      this.revision = nextRevision;
      this.items = [...(descriptor.items || [])];
      return true;
    }

    applyIngest(receipt, response) {
      if (!receipt || !this.pending.has(receipt.token)) return false;
      this.pending.delete(receipt.token);
      if (receipt.draftId !== this.id || receipt.workspaceGeneration !== this.workspaceGeneration) return false;
      if (response && response.draft && response.draft.id === this.id) {
        this.applySnapshot(response.draft);
      } else if (response && Array.isArray(response.items)) {
        const existing = new Map(this.items.map((item) => [item.id, item]));
        for (const item of response.items) existing.set(item.id, item);
        this.items = [...existing.values()];
      }
      const messages = [];
      if (response && response.error) messages.push(response.error);
      for (const entry of (response && response.errors) || []) if (entry && entry.error) messages.push(entry.error);
      this.error = messages.join(" ") || null;
      return true;
    }

    remove(attachmentId) {
      this.items = this.items.filter((item) => item.id !== attachmentId);
    }

    beginSend() {
      if (!this.id || this.sending || this.pending.size > 0) return null;
      this.sending = true;
      return { draftId: this.id, workspaceGeneration: this.workspaceGeneration };
    }

    rejected(receipt, error) {
      if (!receipt || receipt.draftId !== this.id || receipt.workspaceGeneration !== this.workspaceGeneration) return false;
      this.sending = false;
      this.error = error || "The message was rejected";
      return true;
    }

    accepted(receipt, replacement) {
      if (!receipt || receipt.draftId !== this.id || receipt.workspaceGeneration !== this.workspaceGeneration) {
        // Never leave the composer permanently sealed after a send attempt.
        this.sending = false;
        return false;
      }
      this.reset(replacement || null);
      return true;
    }

    /** Clear local send lock without dropping attachments (nav / recovery). */
    clearSending() {
      this.sending = false;
      return this.snapshot();
    }

    snapshot() {
      return {
        id: this.id,
        workspaceGeneration: this.workspaceGeneration,
        revision: this.revision,
        items: [...this.items],
        error: this.error,
        pending: this.pending.size,
        sending: this.sending,
      };
    }
  }

  return { DraftState, sameBinding };
});
