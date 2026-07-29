import type { Diagnostic } from "../../shared/domain";
import type { ApiWarning } from "../../shared/api-contract";

interface DiagnosticNoticeProps {
  diagnostics: Array<Diagnostic | ApiWarning>;
}

export function DiagnosticNotice({ diagnostics }: DiagnosticNoticeProps) {
  if (diagnostics.length === 0) return null;

  return (
    <aside className="diagnostics" aria-label="Session diagnostics">
      <strong>
        {diagnostics.length} diagnostic{diagnostics.length === 1 ? "" : "s"}
      </strong>
      <ul>
        {diagnostics.map((item, index) => (
          <li key={`${item.code}-${index}`}>{item.message}</li>
        ))}
      </ul>
    </aside>
  );
}
