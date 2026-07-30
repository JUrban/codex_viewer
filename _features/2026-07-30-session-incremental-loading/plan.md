# Isolate session incremental loading from catalog changes

Date: 2026-07-30

This ExecPlan is a living document. The sections Progress, Review Scope, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective must stay up to date as work proceeds. If the scope shifts, rewrite affected sections so the document remains coherent and self-contained.

## Purpose / Big Picture

The reader already loads one session timeline in ordinal pages, but every page and lazy tool or directive request is tied to a catalog-wide `generation`. When any active Codex rollout changes, that global generation changes and unrelated sessions restart from their first page. After this change, a user can keep paging through session A while session B is continuously updated. Session A restarts only when session A's own published view changes.

The observable proof is a two-session regression: fetch session A's first page and revision, mutate session B repeatedly, refresh the repository, then continue session A's next page and lazy detail with the original revision. Those requests must succeed while the catalog generation advances. Mutating session A must instead make its old revision fail with HTTP 409.

This feature does not add JSONL tail parsing, file watchers, historical snapshots, automatic infinite scroll, or session-list cursor stability. Existing whole-file decoding, immutable snapshot publication, ordinal pagination, response size limits, polling cadence, and read-only security boundaries remain in place.

## Progress

- [x] (2026-07-30 12:19Z) Confirmed that the feature covers timeline items inside one session, not catalog-list pagination.
- [x] (2026-07-30 12:19Z) Traced source refresh, catalog publication, API generation checks, reader restart behavior, lazy details, and concurrency tests.
- [x] (2026-07-30 12:29Z) Compared source-owned and aggregate-owned revision designs, obtained an independent architecture critique, and selected aggregate final-view revisions.
- [x] (2026-07-30 12:29Z) Recorded the 3,000-session scale baseline and a disposable digest-cost probe in `uncertainty.md`.
- [x] (2026-07-30 12:35Z) Obtained explicit approval for this ExecPlan.
- [x] (2026-07-30 12:38Z) Assessed the decision as ADR-worthy and recorded ADR-0004 without superseding ADR-0001.
- [x] (2026-07-30 12:46Z) Milestone 1 server implementation: split catalog and session consistency domains, added final-view digesting and revision reconciliation, and passed 44 targeted server tests plus the server TypeScript configuration. The browser TypeScript configuration remains intentionally red until Milestone 2 migrates client callers.
- [x] (2026-07-30 12:53Z) Milestone 2 browser implementation: migrated catalog and reader callers to separate consistency fields, preserved accumulated pages and lazy detail across unrelated catalog changes, retained bounded selected-session stale recovery and request isolation, and passed 54 client tests, both TypeScript configurations, and all 118 tests.
- [x] (2026-07-30 12:58Z) Milestone 3: migrated the scale benchmark to both consistency domains, proved no-change/append/replacement behavior and unrelated-token readability at 3,000 sessions, documented the wire contract and unchanged whole-file decoder, and passed typecheck, all 118 tests, production build, benchmark, and diff validation.
- [x] (2026-07-30 13:08Z) Completed Phase 7 code simplification: made digest null encoding and reader control flow explicit, carried the `SessionRevision` semantic type through client boundaries, retained the intentionally explicit registry/query/HTTP consistency checks, and passed targeted and full validation.
- [x] (2026-07-30 13:10Z) Completed three-focus quality review: simplicity found no Important/Critical issues; correctness and convention reviews found two Important issues involving historical-token memory growth and mislabeled RSS sampling.
- [x] (2026-07-30 13:18Z) User approved both Important fixes; replaced the unbounded historical-token set with process-key/sequence revision derivation and corrected the benchmark to report OS process maxRSS plus explicitly named stage-end RSS samples.
- [x] (2026-07-30 13:20Z) Validated both quality-review fixes with 10,000-change revision coverage, typecheck, all 119 tests, production build, corrected 3,000-session benchmark, and diff validation.
- [x] (2026-07-30 13:22Z) Targeted re-review found no remaining Important/Critical issues in token derivation, sequence failure semantics, RSS units, or benchmark labeling.
- [x] (2026-07-30 13:24Z) Reconciled review scope and completed Outcomes & Retrospective; implementation and quality review are complete with no deferrals.
- [x] (2026-07-30 13:38Z) Fixed follow-up review finding P2 by canonicalizing published `childIds` at the aggregate boundary, hashing their exact published order, and adding digest, aggregate, and repository-level reorder regressions without changing the UI.

## Review Scope

Review must cover the consistency-domain design, canonical view hashing, atomic revision publication, HTTP contract, client request lifecycle, regression coverage, documentation, and performance evidence.

### Commits to review

- `5abeaf3` — approved feature packet and ADR-0004 consistency-boundary decision.
- `6b0e1d5` — Milestone 1 final-view digest, opaque revision registry, split server contract, and isolation regressions.
- `63fb9a6` — Milestone 2 client migration, page/lazy-detail preservation, and bounded stale recovery regressions.
- `1920230` — Milestone 3 documentation, deterministic scale isolation assertions, and full validation evidence.
- `a46cd5b` — Phase 7 semantic revision typing and explicit digest/reader control-flow simplification.
- `8016bb4` — user-approved bounded revision allocation and corrected process maxRSS reporting.
- `742c058` — canonical published child ordering, exact-response digesting, and source reorder regressions.

### Uncommitted changes to review

- `_features/2026-07-30-session-incremental-loading/plan.md` — implementation authority, scale evidence, and living execution record.

## Surprises & Discoveries

- Observation: Existing “incremental loading” is HTTP pagination over a fully normalized in-memory timeline, not incremental JSONL tail decoding.
  Evidence: `CodexSessionSource.refresh()` whole-file decodes changed rollout fingerprints, while `SessionQueryService.items()` slices the resulting timeline by physical ordinal.

- Observation: Unrelated-session interruption is deterministic protocol behavior rather than an occasional request race.
  Evidence: any source signature change advances `CatalogSnapshot.generation`; items, tool, and directive requests all require strict equality with that catalog-wide number.

- Observation: The stronger correctness design does not require changing the source adapter port.
  Evidence: the final API-visible session is produced only after aggregate relationship linking rewrites IDs, origin, parent, and child fields. Computing revision material at that final boundary avoids an additional source-owned invariant.

- Observation: A conservative disposable hashing probe did not invalidate final-view digesting, but exposed an allocation gate.
  Evidence: the existing 3,000-session, 112,456,067-byte benchmark cold build took 474.2 ms with 323,698,688 bytes of RSS after measured stages; that value was not a true peak. A `JSON.stringify`-based 54,982,000-byte digest probe took 89.6 ms and added about 70,172,672 RSS bytes, so production code must stream fields into the hash rather than build giant canonical strings.

- Observation: The required A/B regression failed at exactly the predicted catalog-wide guard before implementation.
  Evidence: after changing only session B, session A's next-page request rejected with `The catalog generation changed; restart pagination` from `SessionQueryService.items()`.

- Observation: Splitting the shared contract necessarily makes the browser TypeScript configuration red between Milestones 1 and 2.
  Evidence: `npm run typecheck` now reports only old client `generation` accesses; `npx tsc -p tsconfig.server.json --noEmit` passes. Client edits remain reserved for Milestone 2.

- Observation: The existing React component identity already preserves expanded lazy detail when a quiet refresh returns the same session revision.
  Evidence: timeline keys include session ID and item ID, while `useLazyDetail` now resets only on `sessionRevision`; the catalog-change regression keeps the expanded tool output visible without a second detail request and continues from the previously loaded ordinal cursor.

- Observation: The previous scale corpus returned paths in completion order even though the generator writes files in concurrent batches.
  Evidence: `generateCorpus()` used `paths.push(path)` inside `Promise.all`, while later mutation assumed `paths[0]` was `scale-00000`; storing each path at its numeric session index makes the mutation target deterministic.

- Observation: Final-view digesting adds a visible but explained cold-publication cost without invalidating the scale design.
  Evidence: three 3,000-session, 112,456,067-byte runs measured 565.9-579.3 ms cold construction and 329,105,408-346,406,912 bytes of stage-end RSS, versus the 474.2 ms and 323,698,688-byte pre-change stage-end baseline. The roughly 92-105 ms cold delta matches the pre-implementation 89.6 ms disposable digest-cost probe; no-change refresh remained 154.4-157.3 ms, and one-session append/replacement refreshes remained 243.6-264.7 ms.

- Observation: The earlier RSS values in this plan were stage-end samples, not true peak measurements.
  Evidence: quality review found that `process.memoryUsage().rss` ran only after each asynchronous stage. The corrected benchmark reports `process.resourceUsage().maxRSS` as the process high-water mark and labels stage samples `rssAfter`; the first corrected run reported 349,913,088-byte maxRSS versus 345,571,328 bytes after replacement.

- Observation: The revision registry and reader query methods contain visible repetition that protects important ordering guarantees.
  Evidence: each reader query first resolves the current versioned session and then checks its revision before reading content, while registry preparation keeps token allocation, immutable next-state construction, and the explicit publication commit separate. A generic helper would save little code while making those boundaries less obvious.

- Observation: Digest-only normalization allowed one revision to describe two API-visible `childIds` orders.
  Evidence: the hasher previously sorted `childIds`, while `SessionApiMapper` returned aggregate insertion order. Reordering otherwise identical source entries therefore left the digest unchanged but could change the response array.

## Decision Log

- Decision: Keep catalog list pagination versioned globally, but directly rename its wire field and query to `catalogGeneration`.
  Rationale: list offsets depend on global sorting, search results, facets, and membership; any session can legitimately invalidate them.
  Date/Author: 2026-07-30 / Codex, confirmed by user.

- Decision: Version detail, item pages, tool detail, and directive detail with one opaque string `sessionRevision`.
  Rationale: these endpoints consume one published session view and must not be invalidated by unrelated sessions. One shared token is simpler and safer than prematurely splitting metadata, timeline, and lazy-detail versions.
  Date/Author: 2026-07-30 / Codex, confirmed by user.

- Decision: Compute revision identity from the final aggregate `NormalizedSession`, not from a source-provided fingerprint or revision key.
  Rationale: the aggregate layer owns API-visible IDs, origin, archive and relationship fields. A false negative could silently mix ordinals or lazy detail across different session states, which is more costly than a conservative false invalidation.
  Date/Author: 2026-07-30 / Codex, confirmed by user.

- Decision: Separate an internal deterministic SHA-256 view digest from the externally returned random revision token.
  Rationale: the digest determines whether a view changed, while a random opaque token avoids exposing content equality, paths, timestamps, counters, or process-restart ABA behavior.
  Date/Author: 2026-07-30 / Codex.

- Decision: Require `sessionRevision` even for the first items page.
  Rationale: the client obtains detail first; requiring its token on the first page closes the detail-to-items race and makes the reader handshake explicit.
  Date/Author: 2026-07-30 / Codex.

- Decision: Do not add a compatibility layer for the old `generation` API fields.
  Rationale: the product has not been released and the user explicitly authorized direct API changes; dual names would preserve the ambiguity this feature removes.
  Date/Author: 2026-07-30 / User.

- Decision: Record the consistency-boundary change as ADR-0004 without superseding ADR-0001.
  Rationale: the new decision replaces ADR-0001's reader-wide generation scope but retains its whole-file snapshots, serialized refresh, bounded paging, and recovery model; marking the entire earlier decision superseded would erase still-current rationale.
  Date/Author: 2026-07-30 / Codex, approved by user.

- Decision: Reconcile revisions through a prepared immutable map and an explicit synchronous `commit()` after the complete catalog snapshot has been built.
  Rationale: failed source, linking, search, ordering, or digest work leaves the previously published registry and snapshot unchanged; unused random tokens may be burned but are never reused.
  Date/Author: 2026-07-30 / Codex.

- Decision: Accept exactly 32-character base64url revision tokens at HTTP boundaries.
  Rationale: production allocation is fixed at 192 random bits, so an exact bounded shape rejects malformed, duplicated, and oversized inputs without exposing digest or current-token material.
  Date/Author: 2026-07-30 / Codex.

- Decision: Preserve the existing one-retry detail-to-first-page handshake and change only its stale predicate and token.
  Rationale: this keeps recovery bounded under continuous target-session churn and retains the established AbortController and request-identity safeguards; a regression proves two stale item responses cause exactly two detail and two item requests before surfacing the error.
  Date/Author: 2026-07-30 / Codex.

- Decision: Make the scale benchmark fail on consistency-domain regressions rather than only print version values.
  Rationale: cold and refresh timing alone cannot prove the feature; every append/replacement run now requires catalog advancement, a changed target revision, an unchanged unrelated revision, and successful reading with the unrelated session's original token.
  Date/Author: 2026-07-30 / Codex.

- Decision: Record host-dependent performance evidence against the existing baseline without inventing a fixed percentage gate after implementation.
  Rationale: repeated runs isolate the approximately 100 ms digest cost already predicted by the disposable probe, while retaining concrete corpus, timing, and RSS evidence for review.
  Date/Author: 2026-07-30 / Codex.

- Decision: Limit Phase 7 simplification to explicit control flow and semantic revision typing; do not extract shared registry/query/HTTP helpers or collapse digest field declarations.
  Rationale: the accepted edits remove expression-level ambiguity and primitive-string drift without altering request sequencing. The deferred extractions would reduce line count but obscure atomic publication, 404-before-stale behavior, or the auditability of API-visible digest coverage.
  Date/Author: 2026-07-30 / Codex.

- Decision: Recommend fixing both Important quality-review findings before delivery; the user subsequently approved the recommendation.
  Rationale: retaining every historical random revision makes process memory grow with lifetime churn, while reporting end-of-stage RSS as a peak weakens the performance evidence used to accept final-view hashing. A process-epoch/counter-derived opaque token removes the unbounded set without sacrificing non-reuse, and `process.resourceUsage().maxRSS` provides an actual process high-water mark.
  Date/Author: 2026-07-30 / Codex.

- Decision: Fix both Important findings using HMAC-derived revisions and corrected memory metrics.
  Rationale: a random per-process key plus a 64-bit monotonic input produces fixed-length opaque 192-bit tokens without exposing the counter or storing historical revisions; `process.resourceUsage().maxRSS` supplies the missing process high-water mark while stage RSS remains useful when named accurately.
  Date/Author: 2026-07-30 / User and Codex.

- Decision: Canonicalize final published `childIds` by opaque ID using code-unit ascending order, and make the digest consume that published order verbatim.
  Rationale: child relationships are semantically unordered, but an API array has observable order. Canonicalizing once at the aggregate publication boundary gives source enumeration changes one stable response, while hashing the exact response preserves the invariant that one revision identifies one API-visible view. The UI does not consume `childIds` for its existing tree order and remains unchanged.
  Date/Author: 2026-07-30 / User and Codex.

## Outcomes & Retrospective

The original purpose is achieved. A continuously changing session B can advance `catalogGeneration` without changing session A's `sessionRevision`; A's accumulated ordinal pages, expanded tool/directive detail, next cursor, and original revision remain usable. When A itself changes, all reader endpoints reject A's old token with `stale_session_revision`, and the browser performs one bounded detail-to-first-page retry.

The server now canonicalizes final linked `childIds` before publication and derives revision equality from a streaming SHA-256 digest of that exact final API-visible session view. It exposes a separate 192-bit opaque revision derived from a random per-process HMAC key and monotonic sequence, so deleted/reappeared and ABA states do not reuse tokens without retaining process-lifetime history. Catalog list offsets remain guarded by numeric `catalogGeneration` and `stale_catalog_generation`.

Repository, HTTP, browser, canonicalization, registry, and scale regressions cover the split boundary. The final 3,000-session, 112,456,067-byte benchmark measured 620.2 ms cold construction, 154.7 ms no-change refresh, 266.8 ms append refresh, 251.6 ms replacement refresh, and 354,058,240-byte process maxRSS while proving catalog advancement, target revision changes, and unrelated original-token readability. The cold cost is visible and consistent with the pre-implementation digest probe; it did not justify weakening the correctness boundary.

Quality review found no Critical issues. Both Important findings were fixed rather than deferred: revision allocation is bounded in memory, and the benchmark now distinguishes true process maxRSS from stage-end RSS. A later P2 consistency review found and fixed a mismatch between digest normalization and published child order. Typecheck, all 121 tests, production build, scale benchmark, and diff validation pass.

No functional work remains. Future optimization may cache aggregate digests when unchanged normalized object identity and relationship inputs prove reuse safe, but source hints must never authorize revision reuse. The existing same-inode/same-size/same-mtime source fingerprint limitation and the absence of incremental tail parsing remain explicitly outside this feature. The main lesson is that invalidation scope should follow the resource being read, and equality detection, externally visible consistency tokens, and performance evidence should remain separate, auditable concerns.

## Context and Orientation

Work from `/Users/kngin/project/codex_viewer`.

Codex rollout files are live JSONL files. `src/server/adapters/codex/codex-session-source.ts` discovers them, reuses normalized cache entries for unchanged file fingerprints, and whole-file decodes files whose fingerprint changes. `src/server/repository/catalog-snapshot-store.ts` links source-local sessions into API-visible sessions, builds search documents and ordering, and atomically publishes one immutable `CatalogSnapshot`.

Before this feature, that snapshot exposed one numeric `generation`. `src/server/repository/session-query-service.ts` used it both for session-list offset pagination and for timeline pages and lazy tool/directive details. `src/shared/api-contract.ts` therefore returned the same `generation` field from every endpoint, while `src/client/state/use-session-reader.ts` and `src/client/state/use-lazy-detail.ts` restarted session-local state after any catalog change. Milestones 1 and 2 replaced that public contract with `catalogGeneration` for list pagination and `sessionRevision` for the four reader endpoints.

A catalog generation is a snapshot-wide numeric version used to protect session-list offsets. A session revision is an opaque string used to prove that detail, timeline pages, and lazy details refer to one API-visible session view. A view digest is an internal SHA-256 digest of every field observable through the four session reader endpoints. It is never sent to the browser. A revision token is a cryptographically random base64url string allocated whenever that digest changes. ABA means a state changes from A to B and later back to byte-equivalent A; a new token must still be allocated rather than accepting a request from the first incarnation.

The snapshot must retain a registry keyed by opaque session ID containing the prior digest and token. A rebuild computes a complete next registry and snapshot, then publishes both together. An unchanged digest reuses its token even when `catalogGeneration` advances. A changed digest gets a new token derived from a random per-process HMAC key and a monotonic sequence. Deleted entries disappear; a later session with the same ID consumes the next sequence and gets a different token. A process restart creates a fresh key, so tokens are isolated across process incarnations without retaining a history set.

The view digest must cover all fields in the final `NormalizedSession`: the final linked session and its diagnostics, timeline items in their published order, and tool/directive detail maps sorted by item ID. It must explicitly encode field names or ordered positions, union kinds, nullability, and string lengths so distinct views cannot be concatenated into the same byte stream. Child IDs must be sorted by opaque ID before the session is published, and the digest must preserve that published order; semantically unordered map entries remain sorted inside the digest writer. Timeline order must remain unchanged. Catalog-only diagnostics, global warning totals, search documents, and ordering must not enter a session digest unless they alter that session's API response.

## Plan of Work

### Milestone 1 - Publish independent catalog and session versions

Start with a server regression that constructs or copies two sessions, obtains session A's detail, first page, later cursor, and lazy detail, then changes only session B and refreshes. It must demonstrate the current failure before the implementation and prove afterward that `catalogGeneration` changes while A's `sessionRevision` and reader requests remain valid. Add the inverse test: changing A makes its old revision stale while B remains valid. Cover repeated B churn, A replacement/truncation, deletion and same-ID reappearance, and A-to-B-to-A revision non-reuse at the appropriate repository or registry layer.

In `src/shared/domain.ts` introduce `SessionRevision = string` while retaining `CatalogGeneration = number`. In `src/shared/api-contract.ts`, rename status/list response and list query fields to `catalogGeneration`; replace detail/items/tool/directive response and query fields with `sessionRevision`. Do not retain `generation` aliases.

Add `src/server/repository/session-view-digest.ts` as a pure, server-only canonical hasher. It must stream explicit final-view fields into Node's SHA-256 hasher rather than serialize a giant intermediate object. Canonicalize child enumeration order in the aggregate view before hashing. Add focused tests that show stability across map insertion order and aggregate child enumeration order, sensitivity to every API-visible field and lazy detail, and preservation of published child and timeline order.

Add `src/server/repository/session-revision-registry.ts` or an equivalently isolated class. It accepts final linked sessions, compares their digests with the previous successful publication, reuses unchanged tokens, and allocates new 192-bit base64url tokens through an injectable sequence-based factory. Production derives tokens from a random per-process HMAC key and a 64-bit monotonic input, avoiding a process-lifetime history set. Registry reconciliation must construct next state without mutating published state. Unit tests must prove unchanged reuse, changed replacement, delete/reappear non-reuse, ABA non-reuse, process-instance non-reuse, deterministic testing through injection, high-churn non-reuse, and failed-build non-publication where applicable.

Modify `src/server/repository/catalog-snapshot-store.ts` so `CatalogSnapshot` explicitly names `catalogGeneration` and binds each `NormalizedSession` to its `sessionRevision`, preferably in one versioned entry type so a revision cannot be read from a different session map. Compute digests only after `linkRelationships()` has produced final sessions. Publish the next revision registry and snapshot atomically after all sources, relationship linking, search documents, ordering, and digesting succeed. Preserve refresh single-flight and freshness behavior.

Update `src/server/repository/session-query-service.ts`, `src/server/repository/session-repository.ts`, and `src/server/api/session-api-mapper.ts`. List validation must compare only `catalogGeneration`. Detail returns its versioned entry's `sessionRevision`. Items, tool, and directive must look up the requested session entry and require an exactly matching `sessionRevision` before serving content. Split query failures into `stale_catalog_generation` and `stale_session_revision`; keep invalid input separate.

Update `src/server/http/api-router.ts` so list parses a bounded numeric `catalogGeneration`, reader endpoints parse a single bounded base64url `sessionRevision`, and both stale codes map to HTTP 409. Require the revision for every items request, including the first page, and for every tool/directive request. Preserve 404 for a session that does not currently exist and do not echo current tokens in errors.

Update server fixtures and tests in `tests/server/session-architecture.test.ts`, `tests/server/session-repository.test.ts`, `tests/server/api-http.test.ts`, `tests/server/catalog-source.test.ts`, and any compile-discovered callers. Confirm that catalog pagination is still globally invalidated while reader endpoints are invalidated only by their own session.

This milestone is complete when targeted server tests and both TypeScript configurations pass, and the two-session regression proves the user-visible isolation at repository and HTTP boundaries.

### Milestone 2 - Make the browser preserve unrelated session pages

Update `src/client/api/client.ts` so list requests send `catalogGeneration`, while items, tool, and directive requests send `sessionRevision`. Update `src/client/state/request-errors.ts` with separate `isStaleCatalogGeneration` and `isStaleSessionRevision` predicates.

Modify `src/client/state/use-session-list.ts` to use only `catalogGeneration` for list merge, pagination, and restart behavior. Modify `src/client/state/use-session-reader.ts` so the detail-to-first-page handshake, later page requests, quiet-poll preservation, and stale recovery all use `sessionRevision`. Preserve the existing shared AbortController and request identity behavior. A target-session stale response may automatically restart the handshake once; repeated target churn must fail boundedly rather than loop forever.

Modify `src/client/state/use-lazy-detail.ts` to accept a string `sessionRevision`, reset its local detail only when that revision changes, and recognize `stale_session_revision`. Rename props and call sites in `src/client/components/SessionReader.tsx`, `Timeline.tsx`, `ToolItem.tsx`, and `DirectiveItem.tsx`.

Update client fixtures and tests. Add a regression where catalog generation changes due to an unrelated session while the selected session revision stays fixed: manually loaded later events and expanded lazy detail must remain visible and later pages must remain requestable. Retain and rename tests for selected-session revision changes, bounded first-page retry, stale lazy-detail retry, old deferred response isolation, navigation, hidden polling, failed polling, and catalog pagination.

This milestone is complete when all client tests and typechecks pass and a mocked unrelated catalog change cannot reset the selected reader.

### Milestone 3 - Prove scale, document the contract, and close implementation

Update `scripts/benchmark-scale.ts` for the split fields and add measurements for cold build, no-change refresh, one-session append refresh, and peak RSS. Add assertions that a mutation advances `catalogGeneration`, changes only the mutated session's revision, and leaves an unrelated session revision usable. Keep the disposable corpus below `/private/tmp` and retain automatic cleanup.

Update `README.md` to explain the two consistency domains, 409 recovery, required first-page session handshake, and unchanged whole-file parsing behavior. Search the tracked repository for ambiguous old `generation` API uses and remove only those belonging to the public contract; explicitly named internal concepts may remain if they are truly catalog-scoped. Update architecture documentation according to the post-approval ADR assessment.

Run targeted tests, both typechecks, the full test suite, production build, and scale benchmark. Inspect the final diff for accidental compatibility aliases, leaked digest material, path or timestamp exposure, unbounded query input, and unrelated changes. Record commands and concise outputs in Artifacts and Notes, update Review Scope with every milestone commit and any remaining uncommitted feature-packet paths, and make Progress truthful.

This milestone is complete when every validation passes, benchmark evidence is recorded, documentation matches the wire contract, and the work is ready for Phase 7 review.

## Concrete Steps

Run every command from `/Users/kngin/project/codex_viewer`.

Before Milestone 1 implementation, run the focused current tests:

    npm test -- --run tests/server/session-repository.test.ts tests/server/session-architecture.test.ts tests/server/api-http.test.ts

After the initial two-session regression is added but before the fix, capture its expected failure: session B's mutation causes session A's old global token to return `stale_generation`. After the server change, run:

    npm run typecheck
    npm test -- --run tests/server/session-view-digest.test.ts tests/server/session-revision-registry.test.ts tests/server/session-repository.test.ts tests/server/session-architecture.test.ts tests/server/api-http.test.ts tests/server/catalog-source.test.ts

Expected summary:

    Test Files  ... passed
    Tests       ... passed

After Milestone 2, run:

    npm test -- --run tests/client/session-browser-items.test.tsx tests/client/session-browser-polling.test.tsx tests/client/session-browser-catalog.test.tsx tests/client/session-browser-components.test.tsx
    npm run typecheck

After Milestone 3, run:

    npm run typecheck
    npm test
    npm run build
    npm run benchmark:scale
    git diff --check

The benchmark output must identify a 3,000-session corpus larger than 100 MB, report cold/no-change/single-session refresh timings, process maxRSS, and stage-end RSS, and report that unrelated revisions remained stable. Exact timing is host-dependent. Compare cold timing with the recorded pre-change baseline of 474.2 ms; the pre-change 323,698,688-byte memory value is only a stage-end sample and cannot serve as a true maxRSS baseline.

Commit after each milestone with a focused message. Update Progress, Review Scope, Surprises & Discoveries, Decision Log, and validation transcripts before each commit.

## Validation and Acceptance

The feature is accepted only if all of the following are observable:

- With sessions A and B present, reading multiple pages and lazy detail from A continues successfully through repeated B-only updates. A's revision remains byte-for-byte equal while `catalogGeneration` advances.
- A direct update, truncation, replacement, archive/relationship-visible change, or lazy-detail change for A produces a different A revision. Requests carrying A's old revision receive HTTP 409 `stale_session_revision` and never return content from the new view.
- Session-list offset pagination still rejects a stale `catalogGeneration` with HTTP 409 `stale_catalog_generation`.
- Detail and every items request use the same `sessionRevision` handshake. Missing, duplicated, malformed, or oversized revision parameters return HTTP 400.
- A removed session returns 404. If the same opaque session ID later reappears, it receives a token different from every prior incarnation in the process.
- The browser preserves loaded later pages and expanded tool/directive content when only the catalog generation changes. It restarts only when the selected session revision changes.
- Automatic stale recovery is bounded; continuous target-session updates cannot cause an infinite retry loop.
- Canonical hashing is stable for semantically identical views, sensitive to all reader-visible fields, and does not expose its digest through the API.
- Existing page count, byte bounds, search limits, Markdown safety, request isolation, polling visibility, host/origin protection, loopback binding, and read-only behavior continue to pass their tests.
- `npm run typecheck`, `npm test`, `npm run build`, `npm run benchmark:scale`, and `git diff --check` all succeed.

## Idempotence and Recovery

All implementation state is in memory; there is no database or JSONL mutation. Re-running typechecks, tests, builds, and benchmarks is safe. The benchmark creates its corpus only in a random `/private/tmp` directory and removes it in a `finally` block.

If a milestone fails, retain the failing test and repair the smallest responsible layer. The revision registry must expose injectable token creation so deterministic tests do not depend on randomness. A failed catalog rebuild must leave the prior snapshot and revision registry untouched.

Do not partially roll back only the client or server because their wire contracts change atomically. A full milestone commit can be reverted without data migration. If final-view hashing fails the scale gate, first replace large intermediate canonical strings with streaming field updates; if that is insufficient, add an aggregate-layer digest cache keyed by unchanged normalized object identity plus final relationship inputs. Source-provided dirty hints may cause extra recomputation but must never authorize revision reuse. Tail parsing and persistent revisions remain out of scope.

If temporary benchmark or browser artifacts survive an interrupted run, remove only the exact random directory or file created for this feature after verifying its path is below `/private/tmp`. Never delete a broad temporary or workspace root.

## Artifacts and Notes

Pre-implementation evidence:

    Existing scale corpus: 3,000 sessions, 112,456,067 bytes
    Cold catalog: 474.2 ms
    Reported stage-end RSS (not a true peak): 323,698,688 bytes
    Disposable approximate normalized digest probe: 3,000 sessions,
      54,982,000 payload bytes, 89.6 ms, about 70,172,672 RSS bytes

Implementation transcripts, commit SHAs, benchmark comparison, quality-review decisions, and any validation gaps will be appended here as milestones complete.

Milestone 1 red/green evidence:

    Baseline:
      3 server test files passed, 19 tests passed
    Expected pre-fix regression:
      session B changed; session A next page rejected with stale_generation
      at SessionQueryService.items()
    Post-fix:
      npx tsc -p tsconfig.server.json --noEmit
      exit 0
      6 targeted server test files passed, 44 tests passed
      all 14 server test files passed, 64 tests passed
      git diff --check
      exit 0
    Expected inter-milestone gap:
      npm run typecheck fails only in old client generation callers;
      those files are the explicit scope of Milestone 2.

Milestone 2 validation:

    npm test -- --run tests/client/session-browser-items.test.tsx \
      tests/client/session-browser-polling.test.tsx \
      tests/client/session-browser-catalog.test.tsx \
      tests/client/session-browser-components.test.tsx
    4 test files passed, 44 tests passed

    npm test -- --run tests/client
    6 test files passed, 54 tests passed

    npm run typecheck
    exit 0

    npm test
    20 test files passed, 118 tests passed

    git diff --check
    exit 0

Milestone 3 validation:

    npm run typecheck
    exit 0

    npm test
    20 test files passed, 118 tests passed

    npm run build
    Vite built 320 modules; server TypeScript compilation exited 0

    npm run benchmark:scale
    Corpus: 3,000 sessions, 112,456,067 bytes
    Repeated cold catalog: 565.9-579.3 ms
    No-change refresh: 154.4-157.3 ms
    Single-session append refresh: 256.9-264.7 ms
    Single-session replacement refresh: 243.6-252.2 ms
    Observed stage-end RSS: 329,105,408-346,406,912 bytes
    catalogGeneration: 1 -> 2 -> 3
    Mutated revision changed after append and replacement: true
    Unrelated revision stable and original token readable: true

    git diff --check
    exit 0

Phase 7 simplification review:

    Accepted:
      Replace the digest writer's side-effect ternary with an explicit null branch.
      Carry SessionRevision rather than bare string through client API, component,
        and lazy-detail state boundaries.
      Expand reader restart, polling, and selection-transition expressions into
        explicit control flow.

    Not adopted:
      Combine tool and directive query paths behind a generic versioned-detail helper.
      Hide revision-registry preparation and commit behind a shorter reconcile call.
      Generate or reflect over digest fields instead of listing the reader-visible
        domain fields explicitly.

    Rationale:
      These rejected changes primarily reduce line count while weakening auditability
      of stale-check ordering, atomic publication, or canonical digest coverage.

    npm run typecheck
    exit 0

    Targeted server validation:
      4 test files passed, 33 tests passed

    Targeted client validation:
      3 test files passed, 33 tests passed

    npm test
    20 test files passed, 118 tests passed

    npm run build
    Vite built 320 modules; server TypeScript compilation exited 0

    npm run benchmark:scale
    Corpus: 3,000 sessions, 112,456,067 bytes
    Cold/no-change/append/replacement: 578.7/154.3/257.2/246.4 ms
    Reported stage-end RSS before maxRSS correction: 348,209,152 bytes
    catalogGeneration: 1 -> 2 -> 3
    Mutated revision changed and unrelated original token remained readable: true

    git diff --check
    exit 0

Focused quality review:

    Simplicity / DRYness / elegance:
      No Important or Critical findings.

    Bugs / functional correctness:
      Important: benchmark peakRssBytes sampled only RSS after each stage and could
        miss transient digest allocations. Fixed with process maxRSS high-water
        reporting and explicitly named rssAfter stage samples.

    Project conventions / abstractions:
      Important: SessionRevisionRegistry retained every historical token in #issued,
        so memory grew with process-lifetime session churn. Fixed by HMAC-deriving
        fixed-length opaque revisions from a random process key and monotonic
        sequence without retaining historical tokens.

    User disposition:
      Fix both now.

    Fix validation:
      10,000 sequential session changes produced 10,000 distinct revisions without
        a historical-token set.
      Two corrected 3,000-session runs reported process maxRSS of
        349,913,088-354,058,240 bytes.
      Largest reported stage-end RSS was 350,666,752 bytes after replacement.

    Final post-fix validation:
      npm run typecheck
      exit 0
      npm test
      20 test files passed, 119 tests passed
      npm run build
      Vite built 320 modules; server TypeScript compilation exited 0
      npm run benchmark:scale
      Corpus: 3,000 sessions, 112,456,067 bytes
      Cold/no-change/append/replacement: 620.2/154.7/266.8/251.6 ms
      Process maxRSS: 354,058,240 bytes
      catalogGeneration: 1 -> 2 -> 3
      Mutated revision changed and unrelated original token remained readable: true
      git diff --check
      exit 0

    Targeted re-review:
      No remaining Important or Critical findings.
      Sequence exhaustion, failed-prepare behavior, fixed token shape, Darwin/Node
        maxRSS units, and stage-end RSS naming were checked explicitly.

Follow-up child-order consistency fix:

    Finding:
      Digest sorted childIds independently, while the API returned aggregate
      insertion order, allowing one sessionRevision to identify two visible arrays.

    Fix:
      Aggregate publication sorts opaque child IDs with ECMAScript code-unit order.
      Digest consumes the published childIds order without hidden normalization.
      UI files remain unchanged.

    Targeted validation:
      3 server test files passed, 32 tests passed

    Final validation:
      npm run typecheck
      exit 0
      npm test
      20 test files passed, 121 tests passed
      npm run build
      Vite built 320 modules; server TypeScript compilation exited 0
      npm run benchmark:scale
      Corpus: 3,000 sessions, 112,456,067 bytes
      Cold/no-change/append/replacement: 621.6/155.2/261.9/251.4 ms
      Process maxRSS: 350,224,384 bytes
      catalogGeneration: 1 -> 2 -> 3
      Mutated revision changed and unrelated original token remained readable: true
      git diff --check
      exit 0

## Interfaces and Dependencies

Use Node's built-in `node:crypto`; add no runtime dependency.

The shared contract must expose:

    export type CatalogGeneration = number;
    export type SessionRevision = string;

    interface SessionListResponse {
      catalogGeneration: CatalogGeneration;
      // existing list fields unchanged
    }

    interface SessionDetailResponse {
      sessionRevision: SessionRevision;
      session: SessionDetail;
    }

    interface ItemPageQuery {
      afterOrdinal?: number;
      limit?: number;
      sessionRevision: SessionRevision;
    }

    interface ItemPageResponse {
      sessionRevision: SessionRevision;
      // existing page fields unchanged
    }

Tool and directive query/response types must likewise use required `sessionRevision`. Status must return `catalogGeneration`. List query must use optional `catalogGeneration`, required by the server for non-zero offsets.

At the repository boundary, prefer a single entry:

    interface VersionedSession {
      readonly revision: SessionRevision;
      readonly normalized: NormalizedSession;
    }

`CatalogSnapshot.sessions` should map session IDs to `VersionedSession`, preventing normalized content and revision from being read out of separate maps.

The canonical digest module must expose a pure function equivalent to:

    function digestSessionView(session: NormalizedSession): string;

It must hash an explicit, unambiguous field stream and return a private SHA-256 digest. The revision registry must expose an operation equivalent to:

    reconcile(
      sessions: ReadonlyMap<DomainSessionId, NormalizedSession>,
    ): ReadonlyMap<DomainSessionId, VersionedSession>;

Its production token factory uses a random 256-bit process key and HMAC-SHA-256 over a 64-bit monotonic sequence, truncating the output to a 192-bit base64url token. Tests inject a deterministic sequence-based factory. Reconciliation must not mutate previously published entries.

`RepositoryQueryError.code` must include `stale_catalog_generation` and `stale_session_revision`. Client error helpers and retry paths must distinguish them.

The existing React, Vitest, Vite, TypeScript, source adapter, refresh coordinator, normalization, search, and security dependencies remain unchanged.

Plan revision note: the initial ExecPlan was written after the user confirmed the aggregate final-view digest and opaque session revision architecture. After approval, the living sections were updated through all three implementation milestones with commit scope, validation evidence, benchmark comparison, and remaining quality-review work.
