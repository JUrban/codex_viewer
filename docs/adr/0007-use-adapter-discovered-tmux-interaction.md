---
status: accepted
date: 2026-08-01
---

# Use adapter-discovered tmux interaction behind an explicit opt-in

## Context and Problem Statement

The session viewer needs to send prompts and a small set of control keys to an already running agent without taking ownership of the agent process or weakening its default read-only behavior. Agent rollout formats differ, while safely addressing and operating a tmux pane has transport-specific validation and serialization requirements.

## Decision Drivers

- Interaction must remain disabled unless the operator explicitly enables write operations.
- The viewer must not start agents or create, own, or manage tmux servers and panes.
- Agent-specific rollout parsing must remain behind the existing adapter boundary.
- Stale or reused tmux targets must fail closed before every operation.
- Multiline prompts must be delivered as one bracketed-paste submission.

## Considered Options

- Discover a user-activated tmux binding through each agent adapter and execute it through a shared tmux transport.
- Infer or configure process identifiers and write directly to an agent terminal.
- Make the viewer own the agent and terminal lifecycle.

## Decision Outcome

Chosen option: "Discover a user-activated tmux binding through each agent adapter and execute it through a shared tmux transport", because it preserves adapter ownership of agent formats, centralizes transport validation, and keeps process lifecycle outside the viewer.

Interaction is guarded by the global `--enable-interaction` option and remains unavailable for archived sessions. An adapter scans its complete rollout and exposes only its latest binding attempt plus its interaction state. The transport validates the socket owner and type and records the tmux server start time, pane ID, and pane PID; it revalidates all of them before every serialized pane operation.

Interaction state is part of the top-level session detail and item-page read responses rather than a standalone resource. The client has one per-session Live update scheduler, disabled by default, that refreshes both timeline metadata and interaction state. Its default interval is three seconds and its enabled state is stored per session. Pagination adopts the interaction state returned with that page. Message, interrupt, and escape mutations do not refresh immediately or start a faster polling window; the next ordinary Live update tick observes their effects. Archived sessions ignore any stored Live update preference without deleting it.

### Positive Consequences

- Read-only behavior remains the default and is observable through the API and UI.
- Other agent adapters can add their own activation syntax and state parsing without duplicating tmux safety logic.
- The viewer can reconnect after restart by rescanning the rollout and does not need a binding database.
- Pane reuse, server restart, and stale sockets fail closed instead of targeting a different process.
- Timeline and interaction state share one ordered read path and polling lifecycle.

### Negative Consequences

- Users must already run the agent inside tmux and manually execute an activation command.
- Binding availability depends on the activation record being present in the rollout.
- The existing network trust model now protects mutation endpoints as well as reads; binding to a non-loopback address requires external access controls.
- A timeout has an unknown result and cannot be retried automatically without risking duplicate input.
- Interaction feedback is bounded by the configured Live update interval rather than refreshed immediately after a mutation.

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
