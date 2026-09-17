import type { ValidationDiagnostic } from './types';

export function ValidationDetails({ diagnostics, invalid }: { diagnostics: ValidationDiagnostic[]; invalid: number }) {
  if (!diagnostics.length) { return null; }
  return <details>
    <summary>Validation details ({diagnostics.length} of {invalid} excluded rows)</summary>
    <ul>{diagnostics.map((entry, index) => <li key={index}>
      {entry.refId ? `Query ${entry.refId}, ` : ''}frame {entry.frameIndex + 1}{entry.frameName ? ` (${entry.frameName})` : ''}, row {entry.rowIndex + 1}
      {entry.key ? `, ${entry.key}` : ''}: <code>{entry.field}</code> — {entry.reason}
    </li>)}</ul>
  </details>;
}
