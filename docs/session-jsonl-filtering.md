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

- `session_meta` and `turn_context` records do not become timeline items.
- A `response_item` message is accepted only when its role is `user`,
  `assistant`, or `developer`.
- Message content includes only `input_text`, `output_text`, and `text` parts.
  A message without accepted text content is dropped.
- Assistant response messages always become conversation messages.
- A user response message becomes a conversation message only when an
  unused `event_msg/user_message` within two physical line ordinals has the
  same role, phase, and text. The nearest matching event is used and each event
  can be paired only once. Otherwise the response becomes `injected-context`.
- Developer response messages always become `injected-context`.
- An event message paired with a response message is consumed as a duplicate
  and is not emitted separately.
- Valid `user_message` and `agent_message` events require a non-empty string
  `message`. Valid events that remain unpaired become
  `unmatched_user_event` and `unmatched_agent_event` internal items. Their
  original message text is not retained. Invalid message events become safe
  `internal` summaries of their event type.
- A reasoning response without a non-blank summary is dropped. A reasoning
  response with a summary becomes a `reasoning` item.
- Recognized tool calls become tool items. Outputs are attached by `call_id`;
  an output without a corresponding call does not become a timeline item.
- Other typed records become safe `internal` summaries. A record without a
  usable type becomes a diagnostic.

## Conversation view

The default conversation view excludes `internal` and `reasoning` items.
The internal view includes all normalized item kinds, including those two.
Injected context and tool items remain visible in the default view.

## Truncation and paging

Truncation preserves an item but shortens its text; it is not filtering.
Message text is capped at 1,000,000 characters. Injected-context detail and
tool input/output are capped at 256,000 characters. Session previews, item
summaries, tool previews, and search excerpts share a 240-character limit.
Timeline paging may defer otherwise visible items to a later page because of
the item-count and response size limits.
