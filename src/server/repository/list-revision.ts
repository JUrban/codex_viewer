import { createHmac, randomBytes } from "node:crypto";
import type { SessionListQuery } from "../../shared/api-contract.js";
import { normalizeSearchText } from "../search/search-document.js";

export interface CanonicalListQuery {
  readonly q: string | null;
  readonly project: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly archiveScope: "active" | "archived" | "all";
}

export type ListRevisionFactory = (
  query: CanonicalListQuery,
  orderedIds: readonly string[],
) => string;

export function canonicalListQuery(query: SessionListQuery): CanonicalListQuery {
  return {
    q: query.q === undefined
      ? null
      : normalizeSearchText(query.q.trim()),
    project: query.project ?? null,
    from: query.from === undefined ? null : new Date(query.from).toISOString(),
    to: query.to === undefined ? null : new Date(query.to).toISOString(),
    archiveScope: query.archiveScope ?? "active",
  };
}

export function createProcessListRevisionFactory(): ListRevisionFactory {
  const key = randomBytes(32);
  return (query, orderedIds) => {
    const hmac = createHmac("sha256", key);
    frame(hmac, "list-revision-v1");
    frame(hmac, query.q);
    frame(hmac, query.project);
    frame(hmac, query.from);
    frame(hmac, query.to);
    frame(hmac, query.archiveScope);
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
