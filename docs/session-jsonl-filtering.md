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
  fragment and is not decoded until it is terminated.

## Record normalization

- `session_meta` records do not become timeline items. A `turn_context` record
  becomes an `internal` item without retaining its payload.
- A `response_item` message is accepted only when its role is `user`,
  `assistant`, or `developer`.
- Message content includes only `input_text`, `output_text`, and `text` parts.
  A message without accepted text content is dropped.
- Assistant response messages always become conversation messages.
- A user response message becomes a conversation message only when an
  unused `event_msg/user_message` within two physical line ordinals has the
  same role, phase, and text. The nearest matching event is used and each event
  can be paired only once. Otherwise the response becomes `directive`.
- Developer response messages always become `directive`.
- An event message paired with a response message is consumed as a duplicate
  and is not emitted separately.
- Valid `user_message` and `agent_message` events require a non-empty string
  `message`. Valid events that remain unpaired become `directive` items whose
  bounded original text is available through the directive detail endpoint.
  Invalid message events become safe `internal` summaries of their event type.
- Every `token_count` event becomes a `token` item. Only non-negative integer
  counters in `total_token_usage` and `last_token_usage` are retained; missing
  groups become unavailable. Rate limits and unknown payload fields are
  discarded.
- Every reasoning response becomes an `internal` item with event type
  `reasoning`. A supported non-blank summary is retained as bounded plain text;
  otherwise the item uses the safe `Internal event: reasoning` placeholder.
  Encrypted reasoning content is never retained.
- Recognized tool calls become tool items. Outputs are attached by `call_id`;
  an output without a corresponding call does not become a timeline item.
- Other typed records become safe `internal` summaries. A record without a
  usable type becomes a diagnostic.

## Client visibility

Timeline pages include every normalized item kind. The client always displays
user and assistant messages, then independently filters `directive`, `tool`,
`token`, and `internal` items. Those four technical
event kinds are hidden by default and can be enabled without reloading the
timeline. Enabled kinds are stored in the page URL as one comma-separated
`show` parameter. The archived-only list filter remains client state and is
sent to the list API without being stored in the page URL.

## Truncation and paging

Truncation preserves an item but shortens its text; it is not filtering.
Message text is capped at 1,000,000 characters. Directive detail and
tool input/output are capped at 256,000 characters. Session previews, item
summaries, tool previews, and search excerpts share a 240-character limit.
Timeline paging may defer items to a later page because of the 512-item and
4 MiB response size limits. Client-side filtering never changes page cursors.
