import type { Diagnostic } from "../../shared/domain";

interface DiagnosticNoticeProps {
  diagnostics: Diagnostic[];
  label: string;
}

export function DiagnosticNotice({ diagnostics, label }: DiagnosticNoticeProps) {
  if (diagnostics.length === 0) return null;

  return (
    <aside className="diagnostics" aria-label={label}>
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
