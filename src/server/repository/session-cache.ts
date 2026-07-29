import type { CatalogMetadata } from "../codex/catalog-source.js";
import { DECODER_VERSION } from "../codex/limits.js";
import type { NormalizedSession } from "../domain/session-domain.js";
import type { RolloutDescriptor } from "../security/path-policy.js";

export interface FileFingerprint {
  canonicalPath: string;
  device: number | null;
  inode: number | null;
  size: number;
  mtimeMs: number;
  decoderVersion: number;
}

export interface SessionCacheEntry {
  fingerprint: FileFingerprint;
  metadataKey: string;
  normalized: NormalizedSession;
  threadId: string | null;
}

export function fingerprintOf(descriptor: RolloutDescriptor): FileFingerprint {
  return {
    canonicalPath: descriptor.canonicalPath,
    device: descriptor.device,
    inode: descriptor.inode,
    size: descriptor.size,
    mtimeMs: descriptor.mtimeMs,
    decoderVersion: DECODER_VERSION,
  };
}

export function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.canonicalPath === right.canonicalPath &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.decoderVersion === right.decoderVersion;
}

export function metadataKey(metadata: CatalogMetadata | null): string {
  return JSON.stringify(metadata);
}
