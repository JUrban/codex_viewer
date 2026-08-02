---
status: superseded by ADR-0009
date: 2026-07-31
---

# Use conditional read cursors for session resources

Superseded by [ADR-0009](0009-use-opaque-single-writer-timeline-cursors.md).

## Context and Problem Statement

Session detail, timeline pages, tool detail, and directive detail are different
views of one changing session. ADR-0004 originally made `sessionRevision` an
exact snapshot lock. ADR-0006 then added a separate continuity endpoint so a
reader could migrate an unchanged loaded timeline prefix to a newer revision.
That split produced two consistency protocols: ordinary reads rejected a stale
revision, while continuity reads validated the prefix and asked the client to
retry revision races.

The split is both unnecessary and unsafe for lazy detail. A tool or directive
request can learn that its revision is stale without learning whether the
loaded prefix is still valid. The client must then coordinate revision polling,
continuity migration, and retry state. If migration fails, a pending detail can
remain in a loading state indefinitely.

All session-scoped reads need one conditional-read semantic: the client states
which timeline prefix it has, and the server either returns a response
consistent with that prefix and the newest session revision or rejects the
prefix.

## Decision Drivers

- Give session detail, timeline pages, tool detail, and directive detail the
  same consistency and conflict behavior.
- Preserve loaded pages and mounted UI state across changes after the confirmed
  prefix.
- Fail closed if an item inside the confirmed prefix is modified, removed,
  reordered, replaced, or truncated.
- Eliminate revision-migration requests and retry coordination.
- Return enough state in every response for the client to update session
  metadata and its cursor atomically.
- Keep content-derived material, source fingerprints, and process counters out
  of the API.
- Preserve immutable whole-file snapshots, bounded ordinal pagination, and the
  compact keyed prefix index.

## Considered Options

- Keep exact revision locking and reset all session state after any change.
- Keep exact revision locking plus a separate continuity endpoint and bounded
  client retries.
- Use one conditional read cursor for every session-scoped endpoint.

## Decision Outcome

Chosen option: "Use one conditional read cursor for every session-scoped
endpoint", because the loaded prefix is the actual consistency precondition.
The revision is returned as current state, not used as an exact lock that
requires a second migration protocol.

The shared cursor contains:

- `sessionRevision`: the revision observed with the confirmed prefix.
- `throughOrdinal`: the inclusive end of the confirmed timeline prefix, with
  zero representing the empty prefix.
- `timelinePrefixRevision`: the opaque keyed token for that exact prefix.

An initial session-detail request may omit the cursor. It is treated as a read
of the empty prefix. Every subsequent session-detail, item-page, tool-detail,
and directive-detail request sends the complete cursor. Cursor fields are flat
query parameters on HTTP routes.

The server resolves the session from the newest immutable catalog snapshot. It
validates `throughOrdinal` and `timelinePrefixRevision` against that snapshot on
every conditional read. A matching prefix allows the request even when
`sessionRevision` is older; the response carries the newest
`sessionRevision`. A missing boundary or token mismatch returns
`stale_timeline_prefix`. There is no `stale_session_revision` response and no
client revision retry.

Every successful session-scoped response contains a common `context` envelope:

- the updated cursor;
- the complete latest session detail;
- `hasMore` for the cursor boundary.

Session, tool, and directive reads preserve the confirmed boundary. An item
page starts after that boundary and advances it to the last returned item.
Consequently, any successful response can atomically refresh session metadata
and revision state without discarding loaded timeline items.

The client adopts a response only if the cursor used by the request still
matches its current cursor. This compare-and-set rule prevents concurrent lazy
detail responses from moving state derived from an obsolete boundary. A prefix
conflict stops pending work, preserves the old view, marks details unavailable,
and requires an explicit request to load the latest session from its empty
prefix.

The keyed prefix construction remains unchanged. For each dirty session, the
revision registry canonically encodes each final normalized timeline item once.
The bytes feed both the full session-view digest and a chained HMAC prefix
state. The process-local random key, domain-separated seed, 24-byte states, and
compact `(item count + 1) * 24` byte index keep tokens opaque and prefix lookup
sublinear.

This decision refines ADR-0004 rather than superseding it. `sessionRevision`
still identifies a published session view, while the cursor defines whether a
client's loaded timeline state can be used with the newest view.

### Positive Consequences

- Append-only changes no longer reset accumulated pages or require a migration
  request.
- Session and lazy-detail reads cannot diverge into different revision
  recovery state machines.
- A prefix conflict terminates loading deterministically instead of waiting for
  a revision-triggered retry.
- Modified, deleted, reordered, replaced, and truncated confirmed ranges fail
  closed.
- Every successful response supplies one authoritative session/cursor state.
- Timeline items remain free of per-item consistency metadata.
- Prefix validation uses one boundary lookup and one fixed-size token
  comparison.

### Negative Consequences

- Session metadata is repeated in item and lazy-detail responses.
- Every non-initial session-scoped request must carry three cursor fields.
- The client must compare the request cursor before adopting response context.
- A process restart invalidates client-held prefix tokens even when source
  content is unchanged.
- Every published session retains about 24 bytes per timeline item plus the
  empty-prefix slot and object overhead.
- Timeline ordinals must remain strictly increasing because a cursor cannot
  identify a partial group of duplicate ordinals.
- Client and server are assumed to ship as one local application version; no
  rolling-upgrade compatibility path is provided.

## Pros and Cons of the Options

### Exact revision lock with reset

- Good: Has a small API and client state machine.
- Good: Always starts from a single current snapshot.
- Bad: Ordinary appends destroy accumulated reading context.
- Bad: Treats harmless changes after the loaded range like changes inside it.

### Exact revision lock with separate continuity migration

- Good: Can retain a proven loaded prefix after a revision change.
- Good: Keeps the original read endpoints revision-locked.
- Bad: Adds a migration endpoint, revision polling, retry rules, and
  intermediate client states.
- Bad: Lazy detail can reject on revision before the client knows whether the
  shared prefix is valid.
- Bad: Multiple requests can race while the client migrates between revisions.

### Uniform conditional read cursor

- Good: Makes the prefix precondition explicit and identical for all
  session-scoped resources.
- Good: Returns the newest revision and necessary session state in the original
  request.
- Good: Removes migration requests and revision retries.
- Bad: Repeats the context envelope and cursor parameters across endpoints.
- Bad: Requires compare-and-set response adoption in concurrent clients.
