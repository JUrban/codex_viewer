# Build a local Codex sessions reader

Date: 2026-07-28

This ExecPlan is a living document. The sections Progress, Review Scope, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective must stay up to date as work proceeds. If the scope shifts, rewrite affected sections so the document remains coherent and self-contained.

## Purpose / Big Picture

After this work, a user can run one local command from `/Users/kngin/project/codex_viewer`, open a browser, browse the sessions stored under their local Codex home, filter them by project and time, search titles, paths, and user/assistant messages, and read a safely rendered conversation timeline. The application remains read-only: it never edits Codex files, never uploads session content, never exposes an arbitrary-file API, and binds only to the local loopback interface.

The visible product is a responsive master-detail reader. The left side presents sessions grouped by parent and child relationships. The right side presents an ordinal timeline that distinguishes user messages, assistant commentary and final answers, unavailable reasoning, collapsed tool calls, and optionally visible internal events. Markdown renders without raw HTML or remote images. Active, partially written, damaged, or unknown records degrade to explicit diagnostics instead of breaking the whole session.

The first release deliberately does not edit, delete, resume, export, synchronize, or package sessions as a desktop application. It does not promise universal compatibility with every historical Codex format. It isolates the observed format behind adapters so compatibility can improve without changing the browser-facing model.

## Progress

- [x] (2026-07-28 12:31Z) Confirmed the local, read-only Web MVP problem frame and non-goals with the user.
- [x] (2026-07-28 12:46Z) Explored the empty repository, local toolchain, Codex session formats, storage sources, live-write behavior, and security blind spots.
- [x] (2026-07-28 12:52Z) Recorded completed uncertainty validation loops in `uncertainty.md`.
- [x] (2026-07-28 12:53Z) Confirmed search covers title, project path, and user/assistant text while excluding developer, tool, and encrypted reasoning content.
- [x] (2026-07-28 13:05Z) Compared minimal and evolutionary architectures and obtained user confirmation for the mixed architecture.
- [x] (2026-07-28 13:07Z) Drafted this ExecPlan from the repository evidence, approved architecture, and frontend design guidance.
- [x] (2026-07-28 13:08Z) Obtained explicit user approval for this ExecPlan and recorded ADR-0001.
- [x] (2026-07-28 13:22Z) Milestone 1: established the npm/TypeScript project, browser-safe shared contracts, trace-notebook fixture shell, and secure loopback production server; typecheck, 4 tests, build, HTTP smoke, socket inspection, and desktop/mobile browser inspection passed.
- [ ] Milestone 2: implement safe Codex discovery, tolerant rollout decoding, and normalization.
- [ ] Milestone 3: implement generation-consistent repository snapshots, bounded search, and versioned APIs.
- [ ] Milestone 4: build the responsive session browser and safe timeline reader.
- [ ] Milestone 5: harden, validate, document, and complete quality review.

## Review Scope

Review must cover all code and documentation introduced for the reader, including generated lockfile changes and the feature packet. Update this section after every milestone commit.

### Commits to review

- `dc42247` — initial approved ExecPlan, uncertainty record, and ADR-0001; this is the architecture baseline for implementation review.

### Uncommitted changes to review

- `_features/2026-07-28-codex-sessions-reader/plan.md` — updated Milestone 1 execution record.
- `.gitignore`, `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.server.json`, `vite.config.ts`, `vitest.config.ts`, `index.html` — single-package build, test, and runtime foundation.
- `src/shared/` — browser-safe domain and API contracts.
- `src/server/config.ts`, `src/server/http/`, `src/server/main.ts` — startup-only configuration and loopback HTTP security/static serving boundary.
- `src/client/` — accessible responsive fixture shell and trace-notebook visual system.
- `tests/` — initial HTTP security and client landmark coverage.
- `README.md` — Milestone 1 prerequisites, commands, configuration, and security boundary.

## Surprises & Discoveries

- Observation: A rollout file is not a static chat transcript. It is a live JSONL event stream containing messages, lifecycle events, tool calls, encrypted reasoning, world state, and multi-agent communication.
  Evidence: Fourteen observed rollout files contained six top-level record families and multiple payload unions; several grew during inspection.

- Observation: `response_item` and `event_msg` duplicate message semantics.
  Evidence: Every observed unique assistant `event_msg.agent_message` matched a `response_item.message`, and observed user events were also a subset.

- Observation: Session metadata is not one-to-one with rollout files.
  Evidence: Fourteen rollout files contained fifteen `session_meta` records, including one file with two different metadata records at its start.

- Observation: A persistent full-text index is not justified by the current corpus.
  Evidence: The observed corpus was about 3.3 MB and a complete JSONL parse took about 0.1 seconds locally.

- Observation: `state_5.sqlite` is useful but cannot be the correctness boundary.
  Evidence: Its `threads` table contains titles, paths, archive state, and parent relations, but several title fields are empty and its versioned name indicates schema evolution.

- Observation: The requested independent third architecture review could not be launched because the agent runtime reached its thread limit and exposed no close operation.
  Evidence: Repeated `spawn_agent` calls returned `agent thread limit reached`; a disclosed-bias adversarial review by the minimal-design author was used as the constrained fallback.

- Observation: The user-level npm cache was not writable in the managed environment even though dependency installation itself was allowed.
  Evidence: The prescribed runtime install first failed with `EPERM` at `/Users/kngin/.npm/_cacache/tmp`; the identical npm dependency install succeeded with a disposable cache under `/private/tmp`.

- Observation: Current TypeScript and Vitest releases are stricter than older project templates.
  Evidence: TypeScript 7 required `vite/client` for CSS side-effect imports, and Vitest 4 no longer accepted `environmentMatchGlobs`; file-level `@vitest-environment jsdom` kept server tests in Node and client tests in jsdom.

- Observation: Node's `fetch` does not provide a reliable way to forge a `Host` header for a security test.
  Evidence: A fetch-based test reached the SPA with status 200 despite requesting an attacker Host; the same request made through `node:http` reached the server with the forged authority and was rejected with 403.

## Decision Log

- Decision: Deliver a local Web application before any desktop wrapper.
  Rationale: A Node process can safely mediate local filesystem access while a browser UI remains portable and easy to iterate.
  Date/Author: 2026-07-28 / User and Codex

- Decision: Use a dual-source adapter: opportunistic read-only SQLite metadata plus JSONL detail and fallback discovery.
  Rationale: SQLite provides useful list and relationship fields, but JSONL is the complete event source and is less coupled to one database generation.
  Date/Author: 2026-07-28 / Codex

- Decision: Search only title, project path, and normalized user/assistant message text.
  Rationale: This is useful for finding conversations without indexing developer instructions, tool payloads, or encrypted reasoning.
  Date/Author: 2026-07-28 / User

- Decision: Use the mixed architecture: stable ports, versioned APIs, serialized refresh, immutable generations, and paged timeline responses, but no cross-request tail state, watcher, ETag, Express, TanStack Query, or persistent index.
  Rationale: Paging fixes a demonstrated large-payload risk while whole-file rereads are easier to make correct than an unproven incremental tail state machine.
  Date/Author: 2026-07-28 / User and Codex

- Decision: Treat the catalog, opaque ID registry, normalized cache, and search documents as one generation.
  Rationale: Publishing them atomically prevents list, detail, and search endpoints from observing contradictory source states.
  Date/Author: 2026-07-28 / Codex

- Decision: Give the reader a “trace notebook” visual direction.
  Rationale: Codex history is an execution trace, not a generic admin dataset. A restrained trace gutter can encode event order and kind while the rest of the UI stays quiet and optimized for reading.
  Date/Author: 2026-07-28 / Codex, applying `frontend-design`

- Decision: Record the mixed session snapshot architecture as ADR-0001.
  Rationale: The alternatives and accepted costs are non-trivial, and future maintainers would otherwise lack the reason for generation-scoped whole-file snapshots and paged APIs.
  Date/Author: 2026-07-28 / User and Codex

- Decision: Keep Milestone 1's `/api/` router deliberately empty and return a uniform no-store 404 until the repository-backed handlers arrive in Milestone 3.
  Rationale: This proves that SPA fallback cannot shadow API routes without inventing placeholder status semantics that later milestones would have to preserve.
  Date/Author: 2026-07-28 / Codex

- Decision: Use a disposable npm cache only to work around the environment's unwritable user cache.
  Rationale: This preserves npm, the prescribed dependency set, and the generated lockfile while avoiding changes to user-owned cache permissions or repository configuration.
  Date/Author: 2026-07-28 / Codex

## Outcomes & Retrospective

Milestone 1 delivered a runnable and testable foundation. The production process serves the built fixture shell only from loopback and rejects unsafe request sources and mutation methods. Shared contracts now define the later adapter/repository/UI boundary without Node imports. Desktop and 390 px browser inspection showed a restrained trace rail, readable long-form column, keyboard-addressable controls, meaningful landmarks, and no horizontal document overflow. Real Codex discovery, repository behavior, and session APIs remain intentionally deferred to Milestones 2 and 3.

## Context and Orientation

The repository at `/Users/kngin/project/codex_viewer` is an unborn `main` branch with no application files or commits. Node 26.5.0 and npm 12.0.1 are available. The project will use a single root `package.json` and `package-lock.json`; it will not use npm workspaces or a monorepo.

Codex stores observed sessions below a configurable Codex home. The default is `CODEX_HOME` when set, otherwise `<operating-system home>/.codex`. The reader may inspect only these sources:

- `state_<number>.sqlite`, opened read-only and used only after inspecting available tables and columns.
- `sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`.
- `archived_sessions/rollout-*.jsonl` or nested rollout files if that directory exists and candidates pass the same path policy.
- `version.json` for non-sensitive diagnostics when available.

The reader must never scan or serve `auth.json`, `config.toml`, `shell_snapshots`, log databases, arbitrary workspace files, or the Codex home recursively. A `PathPolicy` converts candidate rollout paths into registered descriptors only after resolving real paths, proving they remain under an allowlisted session root, proving they are regular `.jsonl` files, and validating the rollout filename. HTTP requests use opaque session IDs and ordinal item positions; they never contain filesystem paths.

A rollout is newline-delimited JSON, abbreviated JSONL: each complete line is a separate JSON object. Observed top-level record types include `session_meta`, `turn_context`, `world_state`, `response_item`, `event_msg`, and multi-agent metadata. The file may be appended while it is read. The decoder therefore parses complete newline-terminated lines independently, preserves the physical line ordinal as ordering evidence, ignores an incomplete trailing fragment until a later reread, and turns malformed middle lines into diagnostics.

The normalized domain model is intentionally smaller than the raw event stream. `response_item.message` is the primary source for user and assistant messages. Mirrored `event_msg` records do not produce duplicate messages. Developer content remains server-side and is neither rendered nor searched. Encrypted reasoning bytes are discarded immediately and represented only by an unavailable marker. Tool calls and outputs are untrusted text, paired on call ID when possible, truncated to configured limits, and allowed to remain pending when no output exists. Unknown and lifecycle events become safe type-and-time summaries only when the internal-event view is requested.

`state_<number>.sqlite` is an optimization and metadata source, not a required dependency. The adapter uses Node's built-in `node:sqlite`, opens the database read-only, inspects the `threads` schema, selects only available known columns, validates every returned rollout path through `PathPolicy`, and falls back to JSONL discovery on absence, lock, corruption, or incompatibility. The implementation must run without a SQLite database.

A catalog generation is an immutable snapshot containing session summaries, the opaque-ID-to-rollout registry, file fingerprints, normalized session cache entries, and search documents. Refreshes are serialized so concurrent requests share one rebuild. A fingerprint contains canonical realpath, available device and inode identity, size, `mtimeMs`, and a decoder-version constant. Any shrink, identity change, timestamp anomaly, or version change forces a whole-file reread. The MVP does not retain byte offsets or partial tails between requests.

The user interface subject is “a field notebook for execution traces,” aimed at developers reviewing their own Codex work. Its single job is to help them locate a session and read what happened without losing the distinction between conversation and execution machinery.

The visual token plan is:

- `paper` `#F7FAFA` for the main reading surface.
- `ink` `#18262D` for primary text.
- `mist` `#DCE6E8` for structural dividers and inactive tracks.
- `current` `#176B75` for selection and assistant trace marks.
- `human` `#9D4E3A` for user trace marks.
- `signal` `#C4862D` for warnings, pending tools, and partial data.

Typography uses `Charter, "Iowan Old Style", Georgia, serif` sparingly for session titles; `"Avenir Next", Inter, system-ui, sans-serif` for interface and reading text; and `"SFMono-Regular", Consolas, monospace` for timestamps, paths, event labels, and code. No remote fonts are fetched. The layout is a compact session index beside a calm reading column:

```text
┌──────────────────────┬──────────────────────────────────────────────┐
│ Search / project     │ Session title                 live / warning │
│ time / archive       │ project path · date · children              │
├──────────────────────┼──────┬───────────────────────────────────────┤
│ parent session       │  ●   │ user message                          │
│   child trace        │  │   │                                      │
│ selected session     │  ◇   │ assistant commentary                 │
│ another project      │  │   │                                      │
│                      │  □   │ collapsed tool · status               │
│                      │  │   │                                      │
│                      │  ◆   │ assistant final answer                │
└──────────────────────┴──────┴───────────────────────────────────────┘
```

The signature element is the trace gutter: one narrow semantic rail beside the timeline. Shape and color encode user, assistant, tool, unavailable reasoning, and internal events; ordinal continuity makes the execution sequence tangible. It is functional structure, not decoration. The design avoids dashboard cards, gradients, oversized metrics, excessive rounding, and ornamental animation. The one orchestrated motion is a short trace-draw transition when a new session loads; it is disabled under `prefers-reduced-motion`.

Before implementation, critique this direction against generic UI defaults. If the trace gutter has become decorative or competes with reading, reduce it to shape, color, and a single hairline. Do not add a second signature motif. Use real fixture-derived lengths and states instead of polished placeholder marketing copy.

## Plan of Work

### Milestone 1 - Establish contracts, visual foundations, and the secure local process

Initialize a single npm package with TypeScript, Vite, React, Vitest, and Testing Library. Add `.gitignore`, `README.md`, `package.json`, `package-lock.json`, TypeScript configurations, `vite.config.ts`, `vitest.config.ts`, `index.html`, and scripts for development, build, type checking, tests, and production start. Target Node `>=22.13` because the server uses `node:sqlite` without an npm native addon; verify this target during implementation and raise it if the chosen API requires a newer stable runtime.

Create `src/shared/domain.ts` and `src/shared/api-contract.ts` first. These files define the browser-visible model and may not import Node modules. Define branded or plain string aliases for `SessionId`, `ItemId`, and `CatalogGeneration`; `SessionSummary`; `SessionDetail`; the `TimelineItem` union; diagnostics; list filters; paged item responses; and the uniform API error.

Create `src/server/config.ts`, `src/server/http/create-server.ts`, `src/server/http/router.ts`, `src/server/http/security.ts`, and `src/server/main.ts`. Bind to `127.0.0.1`; allow a configurable port and Codex home only at process startup; reject unexpected Host and cross-origin Origin headers; serve no CORS headers; allow only GET and HEAD; apply a restrictive Content Security Policy, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store` for APIs. In production the same process serves `dist/client` with an SPA fallback that cannot shadow `/api/`.

Create the client entry files and visual tokens in `src/client/main.tsx`, `src/client/App.tsx`, `src/client/styles/tokens.css`, `src/client/styles/global.css`, and `src/client/styles/app.css`. Implement the layout shell and trace-gutter primitives with real accessibility semantics, visible focus, responsive behavior, and reduced-motion handling, but use fixture data until the APIs exist. Review a browser screenshot at desktop and narrow widths. Revise any generic dashboard treatment before committing the milestone.

This milestone is complete when `npm run build`, `npm run typecheck`, and the initial security/layout tests pass; the production server binds only to loopback and serves the built shell; and visual inspection confirms the trace-notebook direction is recognizable without harming readability.

### Milestone 2 - Discover and normalize Codex data without trusting it

Create `src/server/security/path-policy.ts` and `src/server/security/opaque-id.ts`. `PathPolicy` discovers only explicit session roots, resolves each root and candidate with `realpath`, refuses symlink escape and non-regular files, and registers safe rollout descriptors. Opaque IDs are stable path-derived SHA-256 base64url values held in the current catalog map; collisions reject the second descriptor instead of overwriting the first.

Create the infrastructure adapters in `src/server/codex/`: `catalog-source.ts`, `sqlite-catalog-source.ts`, `jsonl-catalog-source.ts`, `rollout-decoder.ts`, `identity-resolver.ts`, `session-normalizer.ts`, `tool-accumulator.ts`, and `limits.ts`. SQLite discovery selects the highest compatible `state_<number>.sqlite`, opens it read-only, feature-detects the `threads` table and columns, and reports non-fatal diagnostics when it must fall back. JSONL discovery scans only allowlisted roots and merges candidates with SQLite results by canonical rollout path.

`RolloutDecoder` streams bytes and emits decoded complete lines with physical ordinals. It never fails the entire file for one malformed line and never parses an incomplete trailing fragment. `IdentityResolver` prefers the database thread-to-path mapping, then a filename-matching metadata ID, then the first plausible metadata record, and finally file-derived values. `SessionNormalizer` emits safe domain items, performs adjacency-scoped mirror deduplication, preserves truly repeated user messages, pairs tool calls without requiring an output, discards encrypted reasoning, and reduces unknown/internal events to safe summaries.

Add synthetic fixtures under `tests/fixtures/codex-home/`; do not copy real user content. Cover a basic session, mirrored events, duplicate metadata, a partial tail, a malformed middle line, unknown event types, pending and completed tools, oversized tool text, child sessions, and missing or incompatible SQLite. Unit tests live under `tests/server/`.

This milestone is complete when the fixture suite proves that parsing continues after bad records, mirrored messages render once, real repeated messages remain, encrypted reasoning never appears in serialized output, SQLite failure falls back to JSONL, and path traversal or symlink escape cannot produce a registered session.

### Milestone 3 - Publish consistent snapshots, bounded search, and versioned APIs

Create `src/server/repository/session-repository.ts`, `src/server/repository/refresh-coordinator.ts`, `src/server/repository/session-cache.ts`, and `src/server/search/search-document.ts`. `SessionRepository` is the application port used by HTTP handlers. `RefreshCoordinator` permits only one rebuild at a time and atomically replaces the catalog snapshot. The snapshot owns summaries, registered descriptors, file fingerprints, normalized cache entries, and search documents under one increasing process-local generation.

Whole-file normalized results are cached by fingerprint. No persistent data, watcher, or cross-request tail offset is introduced. Changed fingerprints replace the complete normalized session and its search document. Search documents contain only normalized title, cwd, user messages, and assistant messages; implement explicit canary tests showing that developer messages, tools, internal events, and reasoning cannot match. Normalize queries consistently, cap query length, scanned bytes, result count, excerpt length, and work duration, and return `partial: true` with a warning whenever a budget is reached.

Add versioned handlers:

- `GET /api/v1/status` returns availability, adapter mode, generation, session count, and safe warning counts without paths.
- `GET /api/v1/sessions` accepts `q`, `project`, `from`, `to`, `archived`, and `limit`, then returns filtered summaries, project facets, parent-child IDs, permitted match excerpts, generation, and partial warnings.
- `GET /api/v1/sessions/:id` returns metadata, diagnostics, item count, source state, and generation.
- `GET /api/v1/sessions/:id/items` accepts `afterOrdinal`, `limit`, and `view=conversation|internal`, then returns a bounded page, `nextAfterOrdinal`, `hasMore`, generation, and source state.
- `GET /api/v1/sessions/:id/items/:itemId/tool` returns bounded plain-text tool input/output only for a registered tool item. It never renders Markdown and may return truncated text.

The page cursor is snapshot-scoped: clients send the generation with subsequent item requests or restart from the first page when the generation changes. Ordinals are not promised stable across generations. API logs contain only opaque IDs and error categories, never search terms, paths, messages, or tool content.

Integration tests use temporary synthetic Codex homes and the real HTTP server. Cover concurrent refresh coalescing, SQLite and JSONL modes, file append and replacement, stale generations, missing sessions, invalid queries, method rejection, Host/Origin rejection, security headers, pagination, tool lazy loading, and bounded-search partial results.

This milestone is complete when the API is usable independently with `curl`, all source-to-response sensitive-field canaries pass, and a file change produces either one old complete generation or one new complete generation but never a mixed view.

### Milestone 4 - Build the responsive session browser

Replace fixture client state with `src/client/api/client.ts` and `src/client/state/use-session-browser.ts`. Use native `fetch`, an `AbortController`, URL search parameters, and small React hooks rather than a client data framework. Search input is debounced; navigation cancels obsolete requests; the selected session and filters survive refresh and browser history. Poll only the selected live session at a low frequency, and stop polling when the document is hidden or the session is no longer live.

Build `SessionFilters`, `SessionTree`, `SessionReader`, `SessionHeader`, `TraceGutter`, `Timeline`, `MessageItem`, `ToolItem`, `InternalEventItem`, `DiagnosticNotice`, `EmptyState`, and `ErrorState` under `src/client/components/`. Parent sessions appear at the top level with nested children; missing parents leave clearly labeled orphan sessions instead of hiding data. The master-detail layout becomes a single-column list/detail flow on narrow screens.

Render Markdown through `react-markdown` and `remark-gfm` without `rehype-raw`. Override links so only explicit `http:`, `https:`, and `mailto:` destinations are clickable, add `noreferrer noopener`, reject `javascript:`, `data:`, and `file:` links, and replace all images with non-loading text placeholders. Code blocks use native `<pre><code>` in the MVP. Tool detail is fetched only when the user expands it, rendered as plain text, and visibly marked when truncated or incomplete.

Apply the trace-notebook design exactly through CSS custom properties. Session title typography is restrained, event semantics are never color-only, the trace gutter remains the sole signature motif, and loading/error/empty copy tells the user what is happening and what action is available. Verify keyboard navigation, focus order, contrast, screen-reader labels, narrow layouts, and `prefers-reduced-motion`.

Client tests cover URL state, request cancellation, grouping, incremental item loading, stale-generation restart, tool lazy loading, internal-event toggle, dangerous Markdown, empty/partial/error states, and polling suspension. Use `playwright-cli` during visual validation to inspect desktop and mobile layouts, keyboard behavior, browser console errors, and unexpected network requests. Take screenshots for critique; do not add image-search or generated bitmap assets because this product's identity is code-native typography and event structure.

This milestone is complete when the user can locate and read real sessions, active updates do not duplicate timeline items, tools remain collapsed and unloaded until requested, no external content loads, and the UI remains usable at desktop and mobile widths.

### Milestone 5 - Harden, document, and review the finished feature

Add synthetic scale fixtures without committing giant generated artifacts. Exercise thousands of summaries, at least a 100 MB generated corpus, long messages, a very large tool output, partial tails, truncation, replacement, permission changes where portable, and an unavailable SQLite database. Record cold catalog time, search latency, detail first-page latency, memory peak where measurable, and response sizes in this plan's Artifacts and Notes.

Use the following gates rather than prematurely optimizing:

- If bounded search exceeds 300–500 ms at the agreed synthetic scale or holds excessive normalized text, record a follow-up design for a removable derived index; do not silently add persistence.
- If whole-file parsing makes first-page detail materially slow, profile whether the bottleneck is decoding, normalization, or response construction before adding a tail reader.
- If observed Codex behavior includes common truncation, rename, or in-place rewrite, preserve full reread as the correctness fallback and document the evidence before proposing incremental state.
- If `node:sqlite` cannot reliably read an active WAL database, disable the adapter by default or add a separately reviewed replacement; never relax read-only behavior.

Complete `README.md` with prerequisites, `npm` commands, configuration, the loopback security model, search scope, compatibility limits, troubleshooting, and uninstall behavior. The reader creates no persistent application data, so stopping the process and deleting the repository fully removes it without touching Codex.

After milestone validation, make Review Scope list every implementation commit and any remaining uncommitted path. Run the required `feature-dev` quality sequence: a code simplifier over that scope, then three focused reviewers for simplicity, functional correctness, and project conventions. Present consolidated issues to the user before applying or deferring review fixes. Update Decision Log, Progress, and Outcomes & Retrospective with fixes, deferrals, measured results, and comparison against Purpose.

This milestone is complete when all automated checks pass, real local read-only smoke tests pass, the browser makes no external requests, the service listens only on loopback, documentation matches behavior, the user has decided the disposition of quality findings, and the plan accurately records the final state.

## Concrete Steps

Run all commands from `/Users/kngin/project/codex_viewer`.

Initialize and install the project dependencies during Milestone 1:

    npm init -y
    npm install react react-dom react-markdown remark-gfm
    npm install --save-dev typescript vite @vitejs/plugin-react tsx vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom @types/node @types/react @types/react-dom

The exact dependency versions are captured in `package-lock.json`. After scripts are defined, use:

    npm run typecheck
    npm test
    npm run build

Expected result after every milestone:

    typecheck exits 0
    vitest exits 0 with all tests passing
    vite build exits 0 and writes dist/client

Run the development server:

    npm run dev

The command prints a loopback URL similar to:

    Codex Sessions Reader listening on http://127.0.0.1:4173

Build and run the production application:

    npm run build
    npm start

Inspect safe status without exposing paths:

    curl --fail --silent http://127.0.0.1:4173/api/v1/status

Expected shape:

    {"available":true,"catalogMode":"sqlite+jsonl","generation":1,"sessionCount":14,"warningCount":0}

Exercise the versioned API with IDs returned by the list endpoint:

    curl --fail --silent 'http://127.0.0.1:4173/api/v1/sessions?limit=10'
    curl --fail --silent 'http://127.0.0.1:4173/api/v1/sessions/<opaque-id>'
    curl --fail --silent 'http://127.0.0.1:4173/api/v1/sessions/<opaque-id>/items?limit=50&view=conversation&generation=<generation>'

Confirm the server is not listening on a non-loopback interface with the platform-appropriate socket inspection command. On macOS:

    lsof -nP -iTCP:4173 -sTCP:LISTEN

Expected address:

    127.0.0.1:4173 (LISTEN)

Run focused validation while implementing:

    npm test -- tests/server/rollout-decoder.test.ts
    npm test -- tests/server/path-policy.test.ts
    npm test -- tests/server/session-normalizer.test.ts
    npm test -- tests/server/session-repository.test.ts
    npm test -- tests/server/http.test.ts
    npm test -- tests/client/session-browser.test.tsx

Run visual and interaction checks after starting the development server:

    playwright-cli open http://127.0.0.1:4173
    playwright-cli snapshot
    playwright-cli console

Use additional `playwright-cli` interactions and screenshots according to its installed skill instructions during implementation.

Inspect repository state before each commit:

    git status --short
    git diff --check
    git diff --stat

Create one incremental commit per completed milestone after its tests pass. Suggested commit subjects are:

    feat: establish codex sessions reader foundation
    feat: normalize local codex session data
    feat: add session repository and read APIs
    feat: build codex session browsing interface
    test: harden and document the sessions reader

## Validation and Acceptance

The complete feature is accepted when all of the following observable behaviors hold:

- Starting the application with the default Codex home shows local sessions sorted by most recently updated, with project and time filters and parent-child grouping.
- Starting with a synthetic `CODEX_HOME` that has JSONL but no SQLite still shows sessions and exposes a safe warning rather than failing.
- Searching a known title, cwd fragment, user phrase, or assistant phrase returns the session. Searching a canary that exists only in a developer message, tool payload, internal event, or encrypted reasoning does not return it.
- Selecting a session shows user and assistant messages exactly once, keeps genuine repeated messages, distinguishes assistant commentary from final answers, and preserves source order when timestamps collide.
- Reasoning content is never returned. The UI presents only an unavailable marker.
- Tool calls are collapsed, show pending/completed/interrupted state, and do not send detailed tool text to the browser until the user expands them. Oversized tool content is truncated with a visible notice.
- Internal events are hidden by default and appear as safe summaries when explicitly enabled.
- A malformed middle JSONL line yields a diagnostic but does not hide later valid messages. An incomplete final line is treated as pending and appears after it becomes complete.
- Replacing, shrinking, or appending a rollout produces a new complete generation. No response combines the old catalog with new search documents or item mappings.
- A stale item request causes the client to restart pagination safely; it may reload an item but does not silently skip items.
- SQLite absence, lock, incompatible schema, or invalid rollout path falls back to allowlisted JSONL discovery.
- API requests cannot read arbitrary paths, traverse with `..`, escape through a symlink, retrieve raw records, or expose Codex home paths.
- The process listens only on `127.0.0.1`, rejects invalid Host or Origin requests, emits no permissive CORS header, and serves restrictive security headers.
- Markdown does not execute raw HTML, load remote images, or activate `javascript:`, `data:`, or `file:` links. Tool text is never treated as Markdown.
- Desktop and narrow layouts remain operable with keyboard-only navigation, visible focus, meaningful labels, sufficient contrast, and reduced-motion support.
- Browser inspection shows no unexpected external requests and no uncaught console errors during the primary browse/search/read flow.
- `npm run typecheck`, `npm test`, and `npm run build` all exit successfully.

The implementation must also be tested against the real local Codex home in read-only mode. Real session contents must never be copied into fixtures, logs, screenshots committed to the repository, or this plan.

## Idempotence and Recovery

Dependency installation and build commands are repeatable. The lockfile makes subsequent installs deterministic. Tests create isolated temporary Codex homes and remove them through their test framework cleanup; they never point mutation helpers at the real Codex home.

The application is read-only by construction. Its file adapter exposes only discovery, stat, and read operations. There are no archive, delete, update, or write endpoints. It creates no cache or index under the Codex home. Stopping the Node process is sufficient rollback for any runtime problem.

If SQLite support fails, set `CODEX_VIEWER_DISABLE_SQLITE=1` and restart. JSONL discovery remains the correctness fallback. If a cache or generation appears inconsistent, restart the process; all derived state is in memory and rebuilds from source files. If a rollout changes unexpectedly, discard its normalized cache entry and reread the whole file instead of trying to repair incremental state.

If a milestone implementation is unsuccessful, preserve user-authored work and revert only the milestone's own commit after inspecting the exact diff. Never use `git reset --hard` or broad checkout commands. Because each milestone is committed independently, the last successful milestone is a safe recovery point.

If dependency installation is blocked by network or sandbox policy, request approval for the exact npm install command rather than changing package managers or bypassing the lockfile. If visual browser automation is blocked, retain automated client tests and request the required browser permission rather than weakening acceptance.

## Artifacts and Notes

Initial empirical baseline:

    repository: no commits and no application files
    Node: v26.5.0
    npm: 12.0.1
    observed Codex CLI: 0.145.0
    observed rollouts: 14
    observed rollout bytes: approximately 3.3 MB
    complete local JSONL parse: approximately 0.1 seconds

Observed raw record families:

    session_meta
    turn_context
    world_state
    response_item
    event_msg
    inter_agent_communication_metadata

The feature packet is:

    _features/2026-07-28-codex-sessions-reader/plan.md
    _features/2026-07-28-codex-sessions-reader/uncertainty.md

Implementation transcripts, generated-scale performance numbers, milestone commit SHAs, visual critique notes, and any validation gaps must be appended here as work proceeds.

Milestone 1 validation:

    npm run typecheck: exit 0
    npm test: 2 files, 4 tests passed
    npm run build: exit 0; dist/client and dist/server emitted
    production smoke: GET / returned 200 with CSP, nosniff, no-referrer, and no CORS
    API boundary smoke: GET /api/v1/status returned safe no-store 404
    socket inspection: node listened on IPv4 127.0.0.1 only
    browser inspection: 1280x720 and 390x844; document scroll width equaled viewport width

The first visual pass retained only the semantic trace rail as the signature motif. Desktop and narrow screenshots were kept in `/private/tmp` for critique and were not added to the repository. The only initial browser console error was a missing favicon request; an empty data favicon removed that irrelevant request without adding an asset or network dependency.

## Interfaces and Dependencies

`src/shared/domain.ts` must define at least:

    type SessionId = string;
    type ItemId = string;
    type CatalogGeneration = number;

    interface SessionSummary {
      id: SessionId;
      title: string;
      preview: string | null;
      cwd: string | null;
      createdAt: string | null;
      updatedAt: string | null;
      archived: boolean;
      parentId: SessionId | null;
      childIds: SessionId[];
      sourceState: "complete" | "live" | "partial" | "unavailable";
      messageCount: number;
      toolCount: number;
      warningCount: number;
    }

    type TimelineItem =
      | MessageItem
      | ToolItem
      | ReasoningUnavailableItem
      | InternalEventItem;

    interface MessageItem {
      kind: "message";
      id: ItemId;
      ordinal: number;
      timestamp: string | null;
      role: "user" | "assistant";
      phase: "commentary" | "final" | null;
      markdown: string;
    }

    interface ToolItem {
      kind: "tool";
      id: ItemId;
      ordinal: number;
      timestamp: string | null;
      toolName: string;
      status: "pending" | "completed" | "failed" | "interrupted";
      preview: string | null;
      truncated: boolean;
      hasDetail: boolean;
    }

    interface ReasoningUnavailableItem {
      kind: "reasoning-unavailable";
      id: ItemId;
      ordinal: number;
      timestamp: string | null;
    }

    interface InternalEventItem {
      kind: "internal";
      id: ItemId;
      ordinal: number;
      timestamp: string | null;
      eventType: string;
      summary: string;
    }

`src/shared/api-contract.ts` must define request/response and error types for `/api/v1/status`, `/api/v1/sessions`, `/api/v1/sessions/:id`, paged items, and tool detail. Paged responses include `generation`, `items`, `nextAfterOrdinal`, and `hasMore`. List responses include project facets, parent-child IDs, safe search excerpts, `partial`, and warnings.

`src/server/codex/catalog-source.ts` must expose a replaceable metadata/discovery boundary similar to:

    interface CodexCatalogSource {
      discover(): Promise<CatalogDiscovery>;
    }

`src/server/codex/rollout-decoder.ts` must expose a whole-file, tolerant boundary similar to:

    interface RolloutDecoder {
      decode(descriptor: RolloutDescriptor): Promise<DecodedRollout>;
    }

`src/server/codex/session-normalizer.ts` must expose:

    interface SessionNormalizer {
      normalize(decoded: DecodedRollout, metadata: SessionMetadata): NormalizedSession;
    }

`src/server/repository/session-repository.ts` must expose read-only application operations similar to:

    interface SessionRepository {
      getStatus(): Promise<StatusResponse>;
      list(query: SessionListQuery): Promise<SessionListResponse>;
      getSession(id: SessionId): Promise<SessionDetailResponse | null>;
      getItems(id: SessionId, query: ItemPageQuery): Promise<ItemPageResponse | null>;
      getToolDetail(id: SessionId, itemId: ItemId): Promise<ToolDetailResponse | null>;
    }

The repository must not expose filesystem paths, SQLite rows, raw Codex records, encrypted reasoning, developer content, or unrestricted tool payloads.

Runtime dependencies are `react`, `react-dom`, `react-markdown`, and `remark-gfm`. Development dependencies are `typescript`, `vite`, `@vitejs/plugin-react`, `tsx`, `vitest`, `jsdom`, Testing Library packages, and TypeScript types for Node and React. Prefer Node standard-library modules for HTTP, crypto, filesystem, path, streams, and SQLite. Do not add Express, an ORM, a native SQLite addon, a watcher, a client state framework, a CSS framework, a syntax highlighter, a persistent search database, or external font and analytics services without revisiting the architecture decision.

Revision note (2026-07-28): Initial plan created after problem framing, repository exploration, uncertainty recording, architecture comparison, user confirmation of the mixed design, and frontend design critique.
