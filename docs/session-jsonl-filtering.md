# Session JSONL filtering rules

This document is the canonical summary of how rollout JSONL records become
timeline items. Keep it synchronized with `rollout-decoder.ts`,
`session-normalizer.ts`, `tool-accumulator.ts`, and
`session-repository.ts`.

## Decode-time skips

- Empty lines are ignored.
- Malformed JSON and JSON values that are not objects are skipped with a
  diagnostic.
- Lines larger than 8 MiB are skipped with a diagnostic.
- A final line without a newline is treated as an incomplete live-write
  fragment and is not decoded or reported until it is terminated.
- Codex session diagnostics retain only the first 50 entries in production
  order. Additional diagnostics are silently discarded.

## Record normalization

- `session_meta` records do not become timeline items. A `turn_context` record
  becomes an `internal` item without retaining its payload.
- A `response_item` message is accepted only when its role is `user`,
  `assistant`, or `developer`.
- Message content includes only `input_text`, `output_text`, and `text` parts.
  A message without accepted text content is dropped.
- Every accepted response message becomes a `directive`; response and event
  records are intentionally retained without duplicate matching.
- Valid `user_message` and `agent_message` events require a non-empty string
  `message` and become user and assistant conversation messages respectively.
  Invalid message events become safe `internal` summaries of their event type.
- An `item_completed` event with an object `item` and non-empty string
  `item.text` becomes an assistant final conversation message. The text is
  interpreted as Markdown and `item.type`, when present, is published as the
  message's `itemType`. Other `item_completed` events become safe `internal`
  summaries.
- Every `token_count` event becomes a `token` item. Only non-negative integer
  counters in `total_token_usage` and `last_token_usage` are retained; missing
  groups become unavailable. Rate limits and unknown payload fields are
  discarded.
- Every reasoning response becomes an `internal` item with event type
  `reasoning`. A supported non-blank summary is retained as bounded plain text;
  otherwise the item uses the safe `Internal event: reasoning` placeholder.
  Encrypted reasoning content is never retained.
- Recognized tool calls and outputs become separate append-stable tool items.
  An output links directly to its preceding call by `call_id` during the same
  forward scan.
- Other typed records become safe `internal` summaries. A record without a
  usable type becomes a diagnostic.

## Client visibility

Timeline pages include every normalized item kind. The client always displays
user and assistant messages, then independently filters `directive`, `tool`,
`token`, and `internal` items. Those four technical
event kinds are hidden by default and can be enabled without reloading the
timeline. Directives up to 500 characters are shown inline as literal
plain-text blocks; longer directives retain their lazy detail control. An
inline directive is also hidden when either of the two preceding or two
following loaded timeline items is a message with exactly the same text. This
comparison uses the unfiltered timeline, so event visibility does not change
the matching neighborhood. Enabled kinds are stored in the page URL
as one comma-separated `show` parameter. The session list uses an explicit
`active | archived | all` archive scope. Active is the default; non-default
scopes are stored in the page URL as `archiveScope`.

## Truncation and paging

Truncation preserves an item but shortens its text; it is not filtering.
Message text is capped at 1,000,000 characters. Directive detail and
tool input/output are capped at 256,000 characters. Session previews, item
summaries, tool previews, and search excerpts share a 240-character limit.
Timeline paging may defer items to a later page because of the 300-item and
4 MiB response size limits. Client-side filtering never changes page cursors.
