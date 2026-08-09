---
status: accepted
date: 2026-07-30
---

# Use session source adapters

## Context and Problem Statement

The reader's normalized session domain, generation snapshot, and HTTP DTOs are intended to remain stable while Codex directory layouts and rollout formats evolve and while other agents are added. The repository previously orchestrated Codex-specific discovery, decoding, identity resolution, normalization, file fingerprints, and I/O recovery, so adding a source required coupling generic snapshot code to that source's storage model.

## Decision Drivers

- Isolate agent-specific directory, format, parsing, and cache behavior.
- Aggregate multiple source instances without native session-ID collisions.
- Preserve generation-scoped lists and bounded detail APIs.
- Keep source paths and configuration identities out of HTTP responses.

## Considered Options

- Keep the repository-level discover/decode/identity/normalize pipeline.
- Introduce high-level session source adapters that return normalized entries.
- Generalize raw event records and parse every agent through one shared decoder.

## Decision Outcome

Chosen option: "Introduce high-level session source adapters that return normalized entries", because each adapter can own its unstable storage compatibility surface while the repository consumes one source-neutral contract.

Each source instance has a private stable instance key and a public opaque instance ID. Adapters return source-local stable session identities, native parent identities, normalized session content, a source signature, and diagnostics. The aggregate snapshot generates global opaque IDs from the source instance key and local identity, links parents only within a source instance, and publishes one immutable generation.

### Positive Consequences

- New agents can be added without teaching the repository their files or formats.
- Native IDs from different agents or installations cannot collide.
- Sessions with a stable native ID retain their viewer ID when their source resource moves.
- Source-specific caching and recovery policies can evolve independently.

### Negative Consequences

- Adapters have a larger contract and must normalize identity and operational failures correctly.
- Source-local identity mistakes can still cause unstable IDs, so contract tests are required.
- Cross-source parent relationships are intentionally unsupported.
- The initial ID migration invalidates path-derived session URLs.

## Pros and Cons of the Options

### Repository-level parsing pipeline

- Good: Uses the existing small interfaces and centralizes refresh behavior.
- Bad: Assumes every source has Codex-like files, decoding stages, and fingerprints.

### High-level session source adapters

- Good: Places unstable storage and parser details behind one boundary.
- Good: Allows one snapshot to merge independently implemented sources.
- Bad: Moves cache and recovery logic into each adapter.

### Shared raw event decoder

- Good: Could reuse normalization when agents expose closely related event schemas.
- Bad: Creates a lowest-common-denominator raw model and leaks format evolution into the shared core.
