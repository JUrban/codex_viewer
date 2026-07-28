# Codex Sessions Reader

A private, read-only Web reader for local Codex session history. The first milestone provides the shared browser/server contracts, secure loopback process, and responsive trace-notebook interface shell. Session discovery and real APIs arrive in later milestones.

## Requirements

- Node.js 22.13 or newer
- npm

## Development

```sh
npm install
npm run dev
```

Open `http://127.0.0.1:4173`. The development shell currently uses synthetic fixture content and does not read Codex files.

## Verify and run the production shell

```sh
npm run typecheck
npm test
npm run build
npm start
```

The production server binds only to `127.0.0.1`. Set `CODEX_VIEWER_PORT` before startup to choose another port. `CODEX_HOME` selects the future read-only data source; it defaults to `~/.codex`. Neither value can be changed through HTTP.

The service rejects non-loopback `Host` values, cross-origin `Origin` values, and methods other than `GET` and `HEAD`. It emits no CORS permission and applies restrictive browser security headers. It currently exposes no session API and never writes to the Codex home.
