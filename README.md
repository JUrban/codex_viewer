# Codex Sessions Reader

A private, read-only Web reader for local Codex session history. It discovers
rollout JSONL files below a configured Codex home, optionally enriches the
catalog from Codex's SQLite state, and serves a responsive browser interface
from the same Node process, bound to loopback by default.

The reader does not edit, archive, delete, resume, export, or upload sessions.
It creates no persistent index or application cache.

## Prerequisites

- Node.js 22.13 or newer. The optional SQLite adapter uses the built-in
  `node:sqlite` module.
- npm, with permission to install the packages pinned by `package-lock.json`.
- A local Codex home. By default this is `~/.codex`.

## Install and start

```sh
npm install
npm run build
npm start
```

Open `http://127.0.0.1:4173`. The startup message prints the exact URL.

The server reads the catalog on demand, so an active rollout can appear or
change without restarting the process. Stop it with `Ctrl-C`.

For client-only development, `npm run dev` starts Vite on loopback. It does not
provide the local session API; use a production build plus `npm start` when
testing real session data.

## Configuration

Configuration is accepted only from the process environment at startup:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Codex home whose `sessions/` and `archived_sessions/` roots may be read. |
| `CODEX_VIEWER_HOST` | `127.0.0.1` | Address or hostname on which the server listens. |
| `CODEX_VIEWER_PORT` | `4173` | TCP port, from `0` through `65535`. Port `0` asks the operating system to choose one. |
| `CODEX_VIEWER_DISABLE_SQLITE` | unset | Set to `1` to skip SQLite metadata and use JSONL discovery only. |

Example:

```sh
CODEX_HOME=/path/to/codex-home CODEX_VIEWER_HOST=0.0.0.0 CODEX_VIEWER_PORT=4180 npm start
```

Changing environment variables requires a restart. There is no HTTP endpoint
for changing paths or configuration.

## Security model

The Node process is the trust boundary between the browser and local files.

- It accepts only `GET` and `HEAD` and emits no permissive CORS header.
- It registers only regular rollout files under the canonical allowlisted
  session roots. Traversal, leaf symlinks, and symlink escapes are rejected.
- Browser APIs use opaque session IDs and never accept filesystem paths or
  expose raw Codex records.
- API responses use `Cache-Control: no-store`. The app also sends a restrictive
  Content Security Policy, `nosniff`, and `Referrer-Policy: no-referrer`.
- Markdown raw HTML is not rendered. Remote images are replaced by text;
  `javascript:`, `data:`, and `file:` links are disabled. Tools show a short
  plain-text preview; capped input and output are loaded only when expanded.
- User-role context injected by Codex, such as project instructions or skill
  content, and developer-role messages are shown as short summaries. Their
  plain-text detail is loaded only when expanded and is capped at 256,000
  characters.

Loopback limits network exposure but does not make an unlocked local account
untrusted. A reverse proxy or non-loopback bind can widen that exposure; enforce
authentication and network access outside the reader.

## Search and large catalogs

Search covers session title, project path, canonical assistant messages, and
user messages corroborated by matching `event_msg.user_message` records. It
excludes directives, tools, reasoning, and internal event payloads.

Search work is bounded by elapsed time, scanned bytes, result count, query
length, and excerpt length. A partial-results notice means a safety budget was
reached; narrow the project or date filters and search again. Search data and
normalized sessions are held only in process memory and disappear when the
server stops.

The session index is paged. Use **Load more sessions** to browse past the first
200 summaries. Catalog and timeline cursors are tied to one generation; if a
rollout changes between pages, the browser restarts safely rather than mixing
old and new data.

## Compatibility and limits

The JSONL reader supports the observed Codex rollout record families and
degrades unknown records to safe summaries or diagnostics. A malformed middle
line does not hide later complete records. An unterminated final line is treated
as a pending live-write fragment until its newline arrives.
The complete decode, normalization, deduplication, and visibility policy is
documented in [Session JSONL filtering rules](docs/session-jsonl-filtering.md).

SQLite is optional metadata, not the correctness boundary. The reader opens
compatible `state_<number>.sqlite` files read-only, feature-detects the
`threads` schema, and falls back to JSONL when the database is absent, locked,
corrupt, or from an unknown schema generation.

Individual JSONL lines over 8 MiB are skipped. Normalized message text is capped
at 1,000,000 characters; directive detail and tool input/output are
capped at 256,000 characters each. Session previews, item summaries, tool
previews, and search excerpts use a shared 240-character limit.
Timeline pages stop at 512 entries or approximately 4 MiB of serialized item
content, whichever comes first; a single valid item is always returned so its
cursor can advance. The first release uses whole-file rereads after a fingerprint
change; it has no watcher, incremental tail state, or persistent full-text index.
Successful catalog discovery is reused for three seconds so a detail request and its
immediately following item or lazy-detail request do not rescan the same catalog.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run benchmark:scale
```

The scale command creates roughly 3,000 synthetic rollouts and more than
100 MiB only below `/private/tmp`, measures catalog/search/detail behavior, and
removes the temporary corpus afterward. It never reads or copies real session
content.

To confirm the production listener on macOS:

```sh
lsof -nP -iTCP:4173 -sTCP:LISTEN
```

With default configuration, the address must be `127.0.0.1:4173`. A safe status
probe is:

```sh
curl --fail --silent http://127.0.0.1:4173/api/v1/status
```

## Troubleshooting

**The page shows no sessions.** Confirm `CODEX_HOME` points to the directory
containing `sessions/`, not to `sessions/` itself. Check that rollout files are
regular files named `rollout-*.jsonl`.

**SQLite warnings appear.** Restart with
`CODEX_VIEWER_DISABLE_SQLITE=1`. JSONL remains the complete-event fallback;
titles or relationship metadata may be less rich.

**A session is partial or unavailable.** Codex may still be writing its final
line, a record may exceed a safety limit, or the source permissions may have
changed. Wait for the writer to finish, restore read permission, and reload.
Restarting the reader clears all derived in-memory state.

**Search reports partial results.** Add a project/date filter or use a more
specific phrase. Partial is an intentional bound, not evidence that source files
were changed.

**The port is already in use.** Choose another port, for example
`CODEX_VIEWER_PORT=4180 npm start`.

## Uninstall

Stop the process and delete this repository (and optionally the npm download
cache managed by npm). The reader has no database, configuration file, watcher,
background service, or cache under the Codex home. Uninstalling it does not
modify or remove Codex sessions.
