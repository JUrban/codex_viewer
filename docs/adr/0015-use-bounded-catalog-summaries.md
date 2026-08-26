---
status: accepted
date: 2026-08-26
---

# Use bounded catalog summaries with lazy timeline hydration

## Context and Problem Statement

The first session-list request previously decoded, normalized, and indexed the
complete history of every discovered rollout. A catalog containing only a few
multi-gigabyte sessions could therefore take a long time to appear even though
the list needs only identity and summary metadata.

## Decision Drivers

- Bound cold catalog work by session count rather than total rollout history.
- Preserve stable opaque session IDs, project filters, parent relationships,
  archive state, cursor validation, and append-only refresh behavior.
- Keep full tool and directive details unavailable until explicitly requested.
- Avoid a persistent cache containing sensitive session data.

## Decision Outcome

The Codex adapter reads at most the first 2 MiB of each unhydrated rollout and
publishes a metadata-only normalized session with an empty timeline. The source
marks that entry as unhydrated. Detail, timeline, live, and interaction reads
ask the catalog store to hydrate the selected source-local session before the
query runs. Hydration performs the existing complete checkpointed decode,
normalization, and timeline-prefix derivation, then atomically republishes the
catalog snapshot.

Source-local IDs observed during bounded discovery are pinned by rollout path
so that hydrating a session cannot invalidate the URL that requested it.
Concurrent hydration requests are serialized and rechecked so requests for
different sessions are not lost. Once hydrated, a session remains in the
existing in-memory incremental cache and normal append refreshes read only the
validated tail.

### Positive Consequences

- Initial catalog I/O is bounded to 2 MiB per discovered rollout.
- JSON parsing, normalization, and HMAC prefix work for historical tool output
  is deferred until that session is opened.
- Opening one session does not hydrate unrelated sessions.
- Existing full-decode and append checkpoint behavior remains unchanged after
  hydration.

### Negative Consequences

- The first open of a large session can still be slow.
- Counts derived from records beyond the bounded prefix are incomplete in the
  catalog response until hydration.
- Summary metadata that occurs only after the bounded prefix may fall back to
  generic values or file modification time.
- Hydration state is process-local, so reopening a session after a server
  restart performs another complete decode.
