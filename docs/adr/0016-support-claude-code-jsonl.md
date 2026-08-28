---
status: accepted
date: 2026-08-26
---

# Support mixed Codex and Claude Code JSONL sources

## Context and Problem Statement

Claude Code session files can be staged beside selected Codex rollouts for an
outsider-facing viewer, but their records are not Codex rollout records. Claude
uses top-level `user` and `assistant` entries and embeds `tool_use` and
`tool_result` blocks inside message content. Sending those files through the
Codex normalizer produces empty or misleading sessions.

## Decision Outcome

Add a separate Claude Code `SessionSource` behind the existing adapter boundary.
It discovers non-rollout JSONL files in the same `sessions/` and
`archived_sessions/` roots, verifies the Claude message shape from a bounded
prefix, and publishes the same normalized domain used by the client. The source
uses lazy hydration and the shared checkpointed decoder, so cold discovery is
bounded and live appends consume only a validated tail after hydration.

The shared session allowlist classifies each entry as Codex or Claude from its
name and bounded record shape, then gives each adapter only its own canonical
paths. Unrecognized files fail closed when explicitly allowlisted and are
silently ignored during ordinary directory discovery.

Claude text, tool calls, and tool results are retained. Claude Code also stores
visible progress updates in `thinking` blocks whose signed metadata labels them
as `narration`; those become commentary messages. Other thinking blocks and
unrelated bookkeeping records are deliberately omitted. Claude sessions do not
publish Codex tmux interaction bindings.

## Consequences

- Codex and Claude sessions can be browsed together without changing the HTTP
  contract or React timeline components.
- Public staging directories and one allowlist can contain both formats.
- Large Claude transcripts have the same bounded-catalog and incremental-tail
  behavior as Codex rollouts.
- The adapter depends on an observed, undocumented Claude Code JSONL shape and
  must be updated if that shape changes.
