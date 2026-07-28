import { createHash } from "node:crypto";

export type OpaqueSessionId = string;

export function opaqueIdForPath(canonicalPath: string): OpaqueSessionId {
  return createHash("sha256").update(canonicalPath, "utf8").digest("base64url");
}

export class OpaqueIdRegistry<T> {
  readonly #entries = new Map<OpaqueSessionId, T>();
  readonly #paths = new Map<OpaqueSessionId, string>();

  constructor(private readonly deriveId: (canonicalPath: string) => OpaqueSessionId = opaqueIdForPath) {}

  register(canonicalPath: string, value: T): OpaqueSessionId {
    const id = this.deriveId(canonicalPath);
    const existingPath = this.#paths.get(id);
    if (existingPath !== undefined && existingPath !== canonicalPath) {
      throw new Error("Opaque session ID collision");
    }
    this.#paths.set(id, canonicalPath);
    this.#entries.set(id, value);
    return id;
  }

  get(id: OpaqueSessionId): T | undefined {
    return this.#entries.get(id);
  }

  entries(): IterableIterator<[OpaqueSessionId, T]> {
    return this.#entries.entries();
  }
}
