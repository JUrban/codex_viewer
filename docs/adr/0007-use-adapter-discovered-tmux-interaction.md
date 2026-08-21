---
status: accepted
date: 2026-08-01
---

# Use adapter-discovered tmux interaction behind an explicit opt-in

## Context and Problem Statement

The session viewer needs to send prompts and a small set of control keys to an already running agent, and provide a bounded on-demand terminal preview, without taking ownership of the agent process or weakening its default read-only behavior. Agent rollout formats differ, while safely addressing and operating a tmux pane has transport-specific validation and serialization requirements.

## Decision Drivers

- Interaction must remain disabled unless the operator explicitly enables pane read and write operations.
- The viewer must not start agents or create, own, or manage tmux servers and panes.
- Agent-specific rollout parsing must remain behind the existing adapter boundary.
- Stale or reused tmux targets must fail closed before every operation.
- Multiline prompts must be delivered as one bracketed-paste submission.
- Terminal output must be captured only on request, remain separate from the canonical rollout timeline, and have a fixed response bound.

## Considered Options

- Discover a user-activated tmux binding through each agent adapter and execute it through a shared tmux transport.
- Infer or configure process identifiers and write directly to an agent terminal.
- Make the viewer own the agent and terminal lifecycle.

## Decision Outcome

Chosen option: "Discover a user-activated tmux binding through each agent adapter and execute it through a shared tmux transport", because it preserves adapter ownership of agent formats, centralizes transport validation, and keeps process lifecycle outside the viewer.

Interaction is guarded by the global `--enable-interaction` option and remains unavailable for archived sessions. An adapter scans its complete rollout and exposes only its latest binding attempt. The transport validates the socket owner and type and records the tmux server start time, pane ID, and pane PID; it revalidates all of them before every serialized pane operation.

Control input uses ordered sequences of agent-independent semantic keys: Enter, Up, Down, Left, Right, Interrupt, and Plan. Each agent adapter maps those semantics to its terminal keys; the Codex adapter maps Interrupt to `C-c` and Plan to `BTab` (Shift+Tab). One sequence is revalidated and sent as one serialized tmux operation, so its keys cannot interleave with another viewer operation.

The same validated binding supports a plain-text terminal preview. Each request captures only the current visible pane, omits terminal escape attributes, and discards older bytes when the result exceeds 256 KiB. Preview content is returned as a separate uncached API resource, held only in browser memory, and never merged into or persisted with the rollout timeline. While expanded, the client refreshes the preview after each one-second delay by default; the user can pause it, and polling stops when the preview is collapsed, hidden, disconnected, or unmounted.

Interaction connection status is part of the top-level session detail and item-page read responses rather than a standalone resource. It is limited to unbound, disconnected, or connected; the viewer does not infer agent activity from rollout events or restrict connected operations according to an inferred activity state. The client has one Live update scheduler for the open session, disabled by default, that refreshes both timeline metadata and connection status. The preference is not persisted: every session page starts with Live updates disabled, including after a browser reload. Archived sessions never start the scheduler.

The Live update preference lifecycle was later refined by [ADR-0014](0014-remember-live-updates-per-browser-tab.md).

### Positive Consequences

- Read-only behavior remains the default and is observable through the API and UI.
- Other agent adapters can add their own activation syntax without duplicating tmux safety logic.
- The viewer can reconnect after restart by rescanning the rollout and does not need a binding database.
- Pane reuse, server restart, and stale sockets fail closed instead of targeting a different process.
- Timeline and interaction connection status share one ordered read path and polling lifecycle.
- Operators can inspect recent terminal-only output without turning the viewer into a terminal owner or treating screen contents as structured session data.

### Negative Consequences

- Users must already run the agent inside tmux and manually execute an activation command.
- Binding availability depends on the activation record being present in the rollout.
- The existing network trust model now protects mutation endpoints as well as reads; binding to a non-loopback address requires external access controls.
- A timeout has an unknown result and cannot be retried automatically without risking duplicate input.
- The viewer cannot indicate whether the connected agent is idle, running, or waiting for user input.
- A preview can expose secrets and unrelated terminal output present in recent scrollback, and large previews require bounded additional memory and transport work.

## Pros and Cons of the Options

### Adapter-discovered binding with shared tmux transport

- Good: Preserves agent and transport boundaries and supports safe revalidation.
- Good: Requires no persistent binding state or terminal lifecycle ownership.
- Bad: Adds an explicit activation step and supports only tmux-backed sessions.

### Infer or configure a terminal process directly

- Good: Could avoid writing an activation marker to the rollout.
- Bad: Process ancestry and terminal reuse are ambiguous, and direct terminal writes lack a portable bracketed-paste operation with tmux-level targeting.

### Viewer-owned agent and terminal lifecycle

- Good: Provides complete knowledge of the target and lifecycle.
- Bad: Materially expands scope into process supervision, session creation, recovery, and persistence, contrary to the viewer's role.
