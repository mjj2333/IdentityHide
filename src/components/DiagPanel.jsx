import { useState, useSyncExternalStore } from 'react';
import {
  isDiagEnabled, subscribeDiag, getDiagEntries, clearDiagLog,
  disableDiagnostics, formatDiagLog,
} from '../utils/perfDiagnostics';
import '../styles/DiagPanel.css';

// Entry types worth drawing the eye to — these are the "it froze" evidence.
const STALL_TYPES = new Set(['stall', 'stall-after-return', 'save-error']);

function clock(t) {
  return `${new Date(t).toTimeString().slice(0, 8)}.${String(t % 1000).padStart(3, '0')}`;
}

/**
 * On-screen viewer for the opt-in diagnostics log (see perfDiagnostics.js).
 * Exists so a freeze can be diagnosed on a phone with no dev tools attached:
 * reproduce, open the panel, tap Copy, paste the log into a message.
 *
 * Collapsed to a small pill by default so it never covers the editor.
 */
export default function DiagPanel() {
  const entries = useSyncExternalStore(subscribeDiag, getDiagEntries);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!isDiagEnabled()) return null;

  const handleCopy = () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1500); };
    try {
      Promise.resolve(navigator.clipboard.writeText(formatDiagLog(entries))).then(done, () => {});
    } catch { /* clipboard unavailable — log stays readable in the panel */ }
  };

  if (!open) {
    const stalls = entries.filter((e) => STALL_TYPES.has(e.type)).length;
    return (
      <button type="button" className="diag-pill" aria-label="Open diagnostics" onClick={() => setOpen(true)}>
        DIAG {entries.length}{stalls > 0 && <span className="diag-pill-stalls"> · {stalls} stall{stalls === 1 ? '' : 's'}</span>}
      </button>
    );
  }

  return (
    <div className="diag-panel" role="region" aria-label="Diagnostics log">
      <div className="diag-panel-bar">
        <span className="diag-panel-title">Diagnostics · {entries.length}</span>
        <button type="button" onClick={handleCopy}>{copied ? 'Copied' : 'Copy'}</button>
        <button type="button" onClick={clearDiagLog}>Clear</button>
        <button type="button" onClick={disableDiagnostics}>Turn off</button>
        <button type="button" aria-label="Close diagnostics" onClick={() => setOpen(false)}>×</button>
      </div>
      <ol className="diag-panel-list">
        {/* Newest first — the freeze you just saw is at the top. */}
        {[...entries].reverse().map((entry, i) => {
          const { t, type, ...details } = entry;
          const rest = Object.entries(details).map(([k, v]) => `${k}=${v}`).join(' ');
          return (
            <li key={`${t}-${entries.length - i}`} className={STALL_TYPES.has(type) ? 'is-stall' : undefined}>
              <span className="diag-time">{clock(t)}</span>
              <span className="diag-type">{type}</span>
              {rest && <span className="diag-details">{rest}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
