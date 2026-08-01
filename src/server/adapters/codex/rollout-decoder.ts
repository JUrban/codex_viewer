import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { Diagnostic } from "../../../shared/domain.js";
import type { RolloutDescriptor } from "./path-policy.js";
import {
  MAX_JSONL_LINE_BYTES,
  MAX_SESSION_DIAGNOSTICS,
} from "./limits.js";

export interface DecodedRecord {
  ordinal: number;
  value: Record<string, unknown>;
}

export interface DecodedRollout {
  descriptor: RolloutDescriptor;
  records: DecodedRecord[];
  diagnostics: Diagnostic[];
}

export interface RolloutDecoder {
  decode(descriptor: RolloutDescriptor): Promise<DecodedRollout>;
}

export class WholeFileRolloutDecoder implements RolloutDecoder {
  async decode(descriptor: RolloutDescriptor): Promise<DecodedRollout> {
    const records: DecodedRecord[] = [];
    const diagnostics: Diagnostic[] = [];
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    let ordinal = 0;
    let droppingOversizedLine = false;

    for await (const chunk of createReadStream(descriptor.canonicalPath)) {
      let text = decoder.write(chunk as Buffer);
      if (droppingOversizedLine) {
        const newline = text.indexOf("\n");
        if (newline < 0) continue;
        ordinal += 1;
        appendDiagnostic(diagnostics, lineTooLargeDiagnostic(ordinal));
        droppingOversizedLine = false;
        text = text.slice(newline + 1);
      }
      buffered += text;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        ordinal += 1;
        decodeLine(line, ordinal, records, diagnostics);
        newline = buffered.indexOf("\n");
      }
      if (Buffer.byteLength(buffered, "utf8") > MAX_JSONL_LINE_BYTES) {
        buffered = "";
        droppingOversizedLine = true;
      }
    }
    // Flush the decoder without consuming the final fragment: JSONL records are
    // committed only by a physical newline, including oversized records.
    decoder.end();
    return {
      descriptor,
      records,
      diagnostics,
    };
  }
}

function decodeLine(
  line: string,
  ordinal: number,
  records: DecodedRecord[],
  diagnostics: Diagnostic[],
): void {
  if (line.length === 0) return;
  if (Buffer.byteLength(line, "utf8") > MAX_JSONL_LINE_BYTES) {
    appendDiagnostic(diagnostics, lineTooLargeDiagnostic(ordinal));
    return;
  }
  try {
    const value: unknown = JSON.parse(line);
    if (!isObject(value)) {
      appendDiagnostic(diagnostics, {
        code: "invalid_record",
        severity: "warning",
        message: "A rollout line was not a JSON object and was skipped.",
        ordinal,
      });
      return;
    }
    records.push({ ordinal, value });
  } catch {
    appendDiagnostic(diagnostics, {
      code: "malformed_json",
      severity: "warning",
      message: "A malformed rollout line was skipped.",
      ordinal,
    });
  }
}

function lineTooLargeDiagnostic(ordinal: number): Diagnostic {
  return {
    code: "line_too_large",
    severity: "warning",
    message: "A rollout record exceeded the decode limit and was skipped.",
    ordinal,
  };
}

function appendDiagnostic(
  diagnostics: Diagnostic[],
  diagnostic: Diagnostic,
): void {
  if (diagnostics.length < MAX_SESSION_DIAGNOSTICS) {
    diagnostics.push(diagnostic);
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
