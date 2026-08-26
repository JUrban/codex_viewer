import { open } from "node:fs/promises";
import type { RolloutDescriptor } from "./path-policy.js";
import { isObject, type DecodedRecord } from "./rollout-decoder.js";

export const MAX_CATALOG_PREFIX_BYTES = 2 * 1024 * 1024;

export interface RolloutSummaryRead {
  readonly records: readonly DecodedRecord[];
  readonly bytesRead: number;
  readonly complete: boolean;
}

export interface RolloutSummaryReader {
  read(descriptor: RolloutDescriptor): Promise<RolloutSummaryRead>;
}

export class BoundedRolloutSummaryReader implements RolloutSummaryReader {
  constructor(private readonly maximumBytes = MAX_CATALOG_PREFIX_BYTES) {}

  async read(descriptor: RolloutDescriptor): Promise<RolloutSummaryRead> {
    const handle = await open(descriptor.canonicalPath, "r");
    try {
      const size = (await handle.stat()).size;
      const end = Math.min(size, this.maximumBytes);
      if (end === 0) return { records: [], bytesRead: 0, complete: true };

      const records: DecodedRecord[] = [];
      const lineParts: Buffer[] = [];
      let lineLength = 0;
      let ordinal = 0;
      let bytesRead = 0;
      const stream = handle.createReadStream({
        autoClose: false,
        start: 0,
        end: end - 1,
      });
      for await (const rawChunk of stream) {
        const chunk = rawChunk as Buffer;
        bytesRead += chunk.length;
        let cursor = 0;
        while (cursor < chunk.length) {
          const newline = chunk.indexOf(0x0a, cursor);
          const partEnd = newline < 0 ? chunk.length : newline;
          if (partEnd > cursor) {
            const part = chunk.subarray(cursor, partEnd);
            lineParts.push(part);
            lineLength += part.length;
          }
          if (newline < 0) break;
          ordinal += 1;
          decodeLine(lineParts, lineLength, ordinal, records);
          lineParts.length = 0;
          lineLength = 0;
          cursor = newline + 1;
        }
      }
      return { records, bytesRead, complete: end === size };
    } finally {
      await handle.close();
    }
  }
}

function decodeLine(
  parts: readonly Buffer[],
  length: number,
  ordinal: number,
  records: DecodedRecord[],
): void {
  if (length === 0) return;
  const raw = parts.length === 1 ? parts[0]! : Buffer.concat(parts, length);
  const line = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
  try {
    const value: unknown = JSON.parse(line.toString("utf8"));
    if (isObject(value)) records.push({ ordinal, value });
  } catch {
    // Catalog discovery is best-effort. Full hydration publishes diagnostics.
  }
}
