# Codex Sessions Reader — Uncertainty Record

## 2026-07-28 12:52Z — Repository and delivery baseline

- Unknown: What existing code, conventions, and toolchain constrain the implementation?
- Actions: Inspected the worktree, Git metadata, project files, installed runtimes, and package-manager availability.
- Evidence: The repository has no commits or application files; Node 26.5.0 and npm 12.0.1 are directly usable, while pnpm and yarn are unavailable without Corepack setup.
- Outcome: Start a single-package TypeScript application with a Node loopback server and React client, managed by npm.
- User decision: The user accepted the recommended local Web application scope.
- Status: resolved
- Implication: No compatibility migration is needed; server, client, and shared domain boundaries can be established from scratch without a monorepo or desktop shell.

## 2026-07-28 12:52Z — Session storage sources

- Unknown: Which local Codex files are authoritative for session lists and conversation details?
- Actions: Enumerated the Codex home structure, inspected JSONL record shapes without exposing message bodies, and queried the state database schema in read-only mode.
- Evidence: `state_5.sqlite/threads` contains list metadata and rollout paths; `sessions/YYYY/MM/DD/rollout-*.jsonl` contains complete event streams; `history.jsonl` is only a partial user-input index.
- Outcome: Use SQLite opportunistically for list metadata and JSONL as the detail source, with a JSONL scan fallback when the database is unavailable or incompatible.
- User decision: None
- Status: resolved
- Implication: The adapter is dual-source and must keep raw Codex formats behind a normalized application model.

## 2026-07-28 12:52Z — Event normalization and duplicate messages

- Unknown: Can rollout records be mapped directly to a simple chat array?
- Actions: Classified all observed top-level and payload types and compared equivalent message contents across `response_item` and `event_msg`.
- Evidence: The same user and assistant messages are mirrored between the two record families; rollouts also contain lifecycle, tool, reasoning, world-state, and multi-agent records.
- Outcome: Normalize `response_item.message` as the primary conversation source, suppress exact mirror events, and retain lifecycle or unknown events as separate safe timeline items.
- User decision: None
- Status: resolved
- Implication: The parser will be tolerant and event-oriented rather than a direct JSON-to-chat mapping.

## 2026-07-28 12:52Z — Live writes and malformed records

- Unknown: Are rollout files immutable and safe to parse as complete JSON documents?
- Actions: Compared file sizes and event counts during active Codex work and checked line-level parse validity and newline termination.
- Evidence: Multiple files grew during inspection; current lines parsed successfully, but JSONL append behavior creates a race with an incomplete final line.
- Outcome: Parse complete newline-terminated records independently, preserve ordinal ordering, isolate malformed lines, and treat a trailing fragment as pending.
- User decision: None
- Status: resolved
- Implication: A bad or half-written line cannot invalidate a session; file changes trigger invalidation and a safe reread.

## 2026-07-28 12:52Z — Session identity, forks, and subagents

- Unknown: Does each rollout have one metadata record and one independent session identity?
- Actions: Compared filenames, database thread IDs, rollout paths, `session_meta` records, and parent/spawn-edge fields across all local samples.
- Evidence: Fourteen rollout files contain fifteen metadata records; one forked rollout starts with two metadata records, and Codex records parent/subagent relationships.
- Outcome: Resolve identity from the database ID and rollout path when possible, otherwise prefer the filename-matching metadata record; represent multi-agent sessions as parent-child groups.
- User decision: Parent-child grouping was accepted as a reversible default.
- Status: accepted assumption
- Implication: The list avoids duplicate or misidentified fork sessions while preserving navigation to child sessions.

## 2026-07-28 12:52Z — Reasoning and tool payload presentation

- Unknown: Which internal records are safe and useful to render?
- Actions: Inspected structural types, sizes, pairing, and displayability of reasoning and tool records without reporting their contents.
- Evidence: Observed reasoning summaries are empty and content is encrypted; tool payloads vary in shape, can be large, and some calls have no matching output.
- Outcome: Never transmit encrypted reasoning; show an unavailable placeholder. Render tool calls as collapsed, size-limited, untrusted text and preserve pending/interrupted states.
- User decision: The user accepted tools collapsed and internal events available on demand.
- Status: resolved
- Implication: Rendering must sanitize Markdown, avoid raw HTML and external resource loading, and never assume call/output pairs are complete.

## 2026-07-28 12:52Z — Search scope and indexing

- Unknown: What content should keyword search cover, and is a persistent full-text index required?
- Actions: Measured the local corpus and full JSONL parse time, reviewed available database metadata, and asked the user to select the sensitive-content boundary.
- Evidence: Fourteen rollouts total roughly 3.3 MB and parse in about 0.1 seconds locally; the user selected title, project path, and user/assistant body text while excluding developer messages, tool payloads, and encrypted reasoning.
- Outcome: Implement bounded in-process search over normalized summaries and message text without a persistent search database in the MVP.
- User decision: Search title, project path, and user/assistant text only.
- Status: resolved
- Implication: Search remains read-only and simple; corpus-size and latency limits become an explicit validation gate before adding an index.

## 2026-07-28 12:52Z — Local security boundary

- Unknown: Does local-only operation make arbitrary Codex-home access acceptable?
- Actions: Inspected relevant file permissions and metadata fields and modeled path traversal, symlink, browser-origin, Markdown, and accidental-secret exposure risks.
- Evidence: Rollouts can contain workspace paths, Git origins, instructions, source text, commands, and outputs; the Codex home also contains credentials and unrelated sensitive files.
- Outcome: Bind only to loopback, use same-origin APIs and opaque session IDs, allowlist session roots and JSONL files after realpath validation, and never recursively expose the Codex home.
- User decision: The user accepted the read-only, non-uploading local application boundary.
- Status: resolved
- Implication: `auth.json`, configuration, snapshots, and unrelated databases are explicitly out of scope, and the browser cannot request arbitrary filesystem paths.

## 2026-07-28 12:52Z — Cross-version and scale compatibility

- Unknown: How broadly can the MVP claim compatibility beyond the observed Codex version and corpus size?
- Actions: Recorded CLI version, database generation, event variants, corpus size, and fallback options.
- Evidence: All observed samples use Codex CLI 0.145.0 and `state_5.sqlite`; naming and open payload unions indicate schema evolution, while older versions and large corpora were not available.
- Outcome: Use feature detection, unknown-event preservation, fixtures, bounded search, and a JSONL fallback; do not claim universal historical compatibility.
- User decision: None
- Status: validation gate
- Implication: Tests must cover missing fields, unknown events, malformed and partial lines, duplicate metadata, and database fallback; future versions can add adapters without changing the UI contract.
