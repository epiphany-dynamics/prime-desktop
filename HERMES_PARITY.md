# Hermes parity contract

Prime Agent Desktop is a hybrid IDE and chat client. Its structural and usability baseline is Hermes Desktop, while retaining Prime Desktop's existing visual identity, colors, and Prime Agent-specific capabilities.

## Non-negotiable product direction

- Match Hermes Desktop's desktop workflow and interaction coverage; do not wait for Patrick to request standard IDE/chat features one at a time.
- The only intentional parity exclusion is voice prompting, dictation, wake-word, and spoken replies.
- Prime Agent capabilities available in the terminal must be discoverable and manageable from the desktop interface when they have a meaningful UI representation.
- Preserve Prime Desktop's current dark visual language rather than copying Hermes branding or colors.
- No feature is complete without keyboard access, loading/empty/error states, and regression coverage.

## Acceptance checklist

### Workspace and sessions
- [x] Searchable, pinnable session sidebar
- [x] Concurrent multi-session panes
- [ ] Drag sessions to split left/right/top/bottom
- [ ] Resizable and persisted split tree; more than two panes
- [ ] Multiple viewers of the same session receive the same live events
- [x] Pop-out windows
- [ ] Project/workspace grouping and recent folders
- [ ] Fork, clone, tree navigation, export, and session action management

### Composer and context
- [x] Multiline prompt/steer composer
- [ ] Inline `/` command palette with fuzzy search and keyboard navigation
- [ ] Inline `@` references for files, folders, URLs, git context, and sessions
- [ ] File and image picker
- [ ] Clipboard-image paste and OS drag/drop attachments
- [ ] Attachment/reference chips, previews, removal, limits, and errors
- [ ] Steer versus follow-up/queue control
- [ ] Prompt history and quick help

### IDE workspace
- [x] File tree and text preview
- [ ] Choose/change the working folder from New Chat and each pane
- [ ] Add file/tree selection to chat
- [ ] File editing and diff review
- [ ] Integrated terminal with multiple tabs
- [ ] Git branch/status/change review controls

### Automation and agents
- [x] Schedule and heartbeat entry points
- [ ] Correct cron/heartbeat data rendering, next/last run, errors, and status
- [ ] Create/edit/pause/resume/clear heartbeats and schedules
- [ ] Live subagent tree via RPC observe, not transcript polling
- [ ] Agent messaging status/send/pause/resume/clear controls

### Prime Agent controls
- [x] Model and thinking controls
- [ ] Compact/refine/retry/auto-compaction/auto-retry controls
- [ ] Goal status and full context/resource statistics
- [ ] Bash execution/abort and queue/action controls
- [ ] Complete command palette for terminal-equivalent operations

### HUD
- [x] Global shortcut and quick prompt
- [ ] Bind to the focused pane/session
- [ ] Stream and display assistant output, tool progress, completion, and errors
- [ ] Abort and open-full-session actions
- [ ] Shared references and attachments with the main composer

### Explicit exclusion
- [x] No voice prompting, dictation, wake word, or text-to-speech parity work
