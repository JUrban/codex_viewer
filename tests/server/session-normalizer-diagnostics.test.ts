import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../../src/shared/domain.js";
import { DefaultSessionNormalizer } from "../../src/server/adapters/codex/session-normalizer.js";
import {
  decodedRollout,
  sessionMetadata,
} from "./session-normalizer.fixtures.js";

describe("session normalizer diagnostics", () => {
  it("does not append tail or unknown-record diagnostics after the decoder reaches the limit", () => {
    const decoded = decodedRollout("full-diagnostics", [{
      ordinal: 51,
      value: {},
    }]);
    decoded.diagnostics = diagnostics(50);
    decoded.incompleteTail = true;

    const normalized = new DefaultSessionNormalizer().normalize(
      decoded,
      sessionMetadata(),
    );

    expect(normalized.session.diagnostics).toEqual(decoded.diagnostics);
    expect(normalized.session.warningCount).toBe(50);
    expect(normalized.session.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "incomplete_tail" }),
    );
    expect(normalized.session.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "unknown_record" }),
    );
  });

  it("keeps only the first 50 diagnostics from a custom decoder", () => {
    const decoded = decodedRollout("custom-decoder-diagnostics", []);
    decoded.diagnostics = diagnostics(60);

    const normalized = new DefaultSessionNormalizer().normalize(
      decoded,
      sessionMetadata(),
    );

    expect(normalized.session.diagnostics).toEqual(
      decoded.diagnostics.slice(0, 50),
    );
    expect(normalized.session.warningCount).toBe(50);
  });

  it("preserves diagnostic order and warning counts below the limit", () => {
    const decoded = decodedRollout("diagnostic-order", [{
      ordinal: 3,
      value: {},
    }]);
    decoded.diagnostics = diagnostics(1);
    decoded.incompleteTail = true;

    const normalized = new DefaultSessionNormalizer().normalize(
      decoded,
      sessionMetadata(),
    );

    expect(normalized.session.diagnostics).toEqual([
      decoded.diagnostics[0],
      expect.objectContaining({
        code: "incomplete_tail",
        severity: "info",
        ordinal: null,
      }),
      expect.objectContaining({
        code: "unknown_record",
        severity: "info",
        ordinal: 3,
      }),
    ]);
    expect(normalized.session.warningCount).toBe(1);
  });
});

function diagnostics(count: number): Diagnostic[] {
  return Array.from({ length: count }, (_, index) => ({
    code: `decoder_warning_${index + 1}`,
    severity: "warning",
    message: `Decoder warning ${index + 1}`,
    ordinal: index + 1,
  }));
}
