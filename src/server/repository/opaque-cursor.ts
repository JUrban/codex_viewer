import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  ListCursor,
  SessionListQuery,
  TimelineCursor,
} from "../../shared/api-contract.js";
import { canonicalListQuery, type CanonicalListQuery } from "./list-revision.js";

const SIGNATURE_BYTES = 24;
const SIGNATURE_CHARS = 32;
const MAX_CURSOR_CHARS = 16_384;

export type CursorDecodeResult<T> =
  | { readonly kind: "valid"; readonly value: T }
  | { readonly kind: "malformed" }
  | { readonly kind: "untrusted" };

interface ListCursorPayload {
  readonly v: 1;
  readonly q: CanonicalListQuery;
  readonly o: number;
  readonly r: string;
}

interface TimelineCursorPayload {
  readonly v: 1;
  readonly s: string;
  readonly o: number;
  readonly p: string;
}

export class OpaqueCursorCodec {
  constructor(private readonly key: Uint8Array = randomBytes(32)) {}

  encodeList(query: SessionListQuery, offset: number, revision: string): ListCursor {
    return this.#encode({
      v: 1,
      q: canonicalListQuery(query),
      o: offset,
      r: revision,
    }) as ListCursor;
  }

  decodeList(cursor: ListCursor): CursorDecodeResult<ListCursorPayload> {
    return this.#decode(cursor, isListCursorPayload);
  }

  listQueryMatches(cursor: ListCursorPayload, query: SessionListQuery): boolean {
    return JSON.stringify(cursor.q) === JSON.stringify(canonicalListQuery(query));
  }

  encodeTimeline(sessionId: string, ordinal: number, prefix: string): TimelineCursor {
    return this.#encode({ v: 1, s: sessionId, o: ordinal, p: prefix }) as TimelineCursor;
  }

  decodeTimeline(cursor: TimelineCursor): CursorDecodeResult<TimelineCursorPayload> {
    return this.#decode(cursor, isTimelineCursorPayload);
  }

  #encode(value: object): string {
    const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.key)
      .update(payload, "utf8")
      .digest()
      .subarray(0, SIGNATURE_BYTES)
      .toString("base64url");
    return `${payload}.${signature}`;
  }

  #decode<T>(
    cursor: string,
    validate: (value: unknown) => value is T,
  ): CursorDecodeResult<T> {
    if (cursor.length === 0 || cursor.length > MAX_CURSOR_CHARS) {
      return { kind: "malformed" };
    }
    const parts = cursor.split(".");
    if (parts.length !== 2) return { kind: "malformed" };
    const [payload, encodedSignature] = parts;
    if (
      !payload ||
      !encodedSignature ||
      !BASE64URL.test(payload) ||
      !BASE64URL.test(encodedSignature) ||
      encodedSignature.length !== SIGNATURE_CHARS
    ) {
      return { kind: "malformed" };
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return { kind: "malformed" };
    }
    if (!validate(value)) return { kind: "malformed" };
    const signature = Buffer.from(encodedSignature, "base64url");
    const expected = createHmac("sha256", this.key)
      .update(payload, "utf8")
      .digest()
      .subarray(0, SIGNATURE_BYTES);
    if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) {
      return { kind: "untrusted" };
    }
    return { kind: "valid", value };
  }
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function isListCursorPayload(value: unknown): value is ListCursorPayload {
  return isRecord(value) && hasOnlyKeys(value, ["v", "q", "o", "r"]) &&
    value.v === 1 && isCanonicalQuery(value.q) && isOrdinal(value.o) &&
    typeof value.r === "string";
}

function isTimelineCursorPayload(value: unknown): value is TimelineCursorPayload {
  return isRecord(value) && hasOnlyKeys(value, ["v", "s", "o", "p"]) &&
    value.v === 1 && typeof value.s === "string" && isOrdinal(value.o) &&
    typeof value.p === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOrdinal(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalQuery(value: unknown): value is CanonicalListQuery {
  if (!isRecord(value)) return false;
  return hasOnlyKeys(value, ["q", "project", "from", "to", "archiveScope"]) &&
    nullableString(value.q) && nullableString(value.project) &&
    nullableString(value.from) && nullableString(value.to) &&
    (value.archiveScope === "active" || value.archiveScope === "archived" ||
      value.archiveScope === "all");
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
