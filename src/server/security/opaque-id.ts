import { createHash } from "node:crypto";

export type OpaqueSessionId = string;

export function opaqueIdForPath(canonicalPath: string): OpaqueSessionId {
  return createHash("sha256").update(canonicalPath, "utf8").digest("base64url");
}
