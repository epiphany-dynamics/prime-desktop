# Prime Agent 0.7 daemon attachment contract

Prime Desktop uses Prime Agent 0.7.1's public `DaemonClient` and
`DaemonAgentConnection` exports when a saved session is already resident in the
per-user daemon. This is a second client attachment to the existing worker, not
a second session runtime.

## Ownership and discovery

1. Desktop connects to the configured daemon socket and waits for the
   `prime-agent.daemon` hello.
2. It sends `list` with `includeClientOwned: true` and compares canonical
   `sessionFile` values. Client-owned rows are visible only when the daemon says
   this client may access them.
3. A matching row is addressed by its opaque `activeSessionId` and attached with:

   ```js
   {
     closeClientOnDispose: true,
     sendClientEnv: false,
     supportsExtensionUi: true,
     ownedSession: false,
   }
   ```

4. The initial snapshot hydrates finalized messages, current state, and any
   in-flight assistant message. Sequenced live events come from
   `DaemonAgentConnection.subscribe`; Desktop does not tail the JSONL file.
5. Every pane showing the canonical session shares Desktop's one client/adapter.
   The adapter stays attached while any pane or the HUD consumes it. Releasing
   the final Desktop consumer (or evicting/quitting) calls `dispose()`, which
   detaches Desktop and closes its socket without stopping/completing the
   resident worker or taking its lease.
6. Desktop starts its existing `prime-agent --mode rpc` child only when daemon
   discovery completes without a matching active session (or no compatible
   daemon exists). An attach failure after a resident match is surfaced instead
   of risking a second writer.

The multi-client/lease behavior was first proven with a read-only second-client
attachment to a live Prime Agent 0.7.1 daemon. Repository tests then reproduce it
with a deterministic fake resident worker: terminal + Desktop produce two
attached clients while the worker retains exactly one session-file writer;
Desktop disposal returns the count to one and never stops the worker.

## Renderer compatibility matrix

The daemon objects remain in Electron main. The sandboxed renderer receives the
same bounded RPC responses and agent events used by process-backed sessions.

| Desktop contract | AgentConnection mapping | Renderer result |
|---|---|---|
| activation/readiness | `getInitialSnapshot()`, `getState()` | canonical session identity, model/thinking/streaming state |
| history | `getMessages()` plus snapshot `streamingMessage` | finalized transcript and an in-flight bubble without an event gap |
| live output | `session_event.event` | existing `agent_start`, message/tool updates, `agent_end`, retry/compaction UI |
| reconnect/resync | `session_resynced` / replacement snapshot | bounded transcript/state rehydration |
| prompt | `prompt(message, {images, streamingBehavior, source:"rpc"})` | existing accepted-send/draft rotation ordering |
| steer | `steer(message, images)` | current steering composer behavior |
| follow-up | `followUp(message, images)` | current follow-up queue behavior |
| stop | `abort()` | current stop button and shared-pane fan-out |
| images | unchanged `{type:"image", data, mimeType}` objects | exact Prime image blocks; no generic-file upload claim |
| models/thinking | `getAvailableModels`, `setModel`, `setThinkingLevel` | existing pickers |
| stats/commands | `getSessionStats`, `getCommands` | context/cost and slash-command surfaces |
| schedules/heartbeats | cron/heartbeat AgentConnection methods | dedicated automation IPC only |
| extension UI | normalized request + `respondToExtensionUiRequest` | existing allowlisted dialog bridge |
| close/evict/app quit | `dispose()` with `ownedSession:false` | detach Desktop only; terminal session continues |

Raw daemon requests, socket paths, executable callbacks, session leases, and
arbitrary filesystem authority are never exposed through preload.

## Offline coverage

- `test/daemon-rpc-adapter.test.js`: two-client/no-second-lease proof, exact
  ownership options, snapshot hydration, live event fan-out, prompt/steer/
  follow-up/abort plus image identity, inactive-only fallback, and detach safety.
- `scripts/ui-smoke.js`: a fake terminal-resident daemon session is discovered,
  attached in a streaming-safe split, streamed live, controlled, switched, and
  identified as `daemon-attachment` while a different pane keeps streaming;
  final-pane detach returns the fake worker to its terminal-only client count.
- `scripts/window-smoke.js`: queued HUD startup, shortcut-failure menu fallback,
  distinct always-on-top HUD visibility, and Dock reactivation with a hidden HUD.

## Detached process RPC and app quit

When no resident daemon session matches, Desktop may start `prime-agent --mode rpc`
as a **detached** child. That child is a worker Desktop can drive over JSONL.

On app quit, last-window close, or leaving the final pane/HUD consumer for that
client, Desktop **detaches**:

- daemon attachments call `dispose()` with non-owning options (worker keeps running)
- process RPC clients are unref'd and left alive — Desktop does **not** SIGTERM them on quit

Deliberate **Restart agents** still stops Desktop-managed workers. The local
installer script also refuses to force-kill the UI so in-flight workers are not
taken down by a botched update.

