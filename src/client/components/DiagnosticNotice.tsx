import type { Diagnostic } from "../../shared/domain";
import type { ApiWarning } from "../../shared/api-contract";

export function DiagnosticNotice({ diagnostics }: { diagnostics: Array<Diagnostic | ApiWarning> }) {
  if (!diagnostics.length) return null;
  return <aside className="diagnostics" aria-label="Session diagnostics">
    <strong>{diagnostics.length} diagnostic{diagnostics.length === 1 ? "" : "s"}</strong>
    <ul>{diagnostics.map((item, index) =>
      <li key={`${item.code}-${index}`}>{item.message}</li>)}</ul>
  </aside>;
}
