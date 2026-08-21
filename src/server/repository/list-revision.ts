import { createHmac, randomBytes } from "node:crypto";
import type { SessionListCriteria } from "./session-query-criteria.js";

export interface CanonicalListFilters {
  readonly project: string | null;
  readonly from: string | null;
  readonly to: string | null;
}

export type ListRevisionFactory = (
  filters: CanonicalListFilters,
  orderedIds: readonly string[],
) => string;

export function canonicalListFilters(query: SessionListCriteria): CanonicalListFilters {
  return {
    project: query.project ?? null,
    from: query.from === undefined ? null : new Date(query.from).toISOString(),
    to: query.to === undefined ? null : new Date(query.to).toISOString(),
  };
}

export function createProcessListRevisionFactory(): ListRevisionFactory {
  const key = randomBytes(32);
  return (filters, orderedIds) => {
    const hmac = createHmac("sha256", key);
    frame(hmac, "list-revision-v1");
    frame(hmac, filters.project);
    frame(hmac, filters.from);
    frame(hmac, filters.to);
    for (const id of orderedIds) frame(hmac, id);
    return hmac.digest().subarray(0, 24).toString("base64url");
  };
}

interface FramedHash {
  update(data: Uint8Array): unknown;
}

function frame(hash: FramedHash, value: string | null): void {
  if (value === null) {
    const nullFrame = Buffer.allocUnsafe(4);
    nullFrame.writeUInt32BE(0xffff_ffff);
    hash.update(nullFrame);
    return;
  }
  const encoded = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(encoded.length);
  hash.update(length);
  hash.update(encoded);
}
