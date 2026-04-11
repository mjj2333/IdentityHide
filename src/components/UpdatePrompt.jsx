import { useEffect } from 'react';
import '../styles/UpdatePrompt.css';

/**
 * Non-blocking toast shown when a new service worker is waiting to take over.
 *
 * Positioned at bottom-center so it doesn't conflict with the DropZone's
 * "Resume session" banner (top of the drop screen) or the warning toast
 * (which uses `.app-toast`, top-right-ish). Dismissible with × or Escape.
 */
export default function UpdatePrompt({ visible, onReload, onDismiss }) {
  useEffect(() => {
    if (!visible) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, onDismiss]);

  if (!visible) return null;

  return (
    <div className="update-prompt" role="status" aria-live="polite">
      <svg className="update-prompt-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="23 4 23 10 17 10" />
        <path d="M20.49 15A9 9 0 1 1 5.64 5.64L23 10" />
      </svg>
      <span className="update-prompt-body">New version available</span>
      <button
        type="button"
        className="btn btn-primary btn-sm update-prompt-reload"
        onClick={onReload}
      >
        Reload
      </button>
      <button
        type="button"
        className="update-prompt-dismiss"
        aria-label="Dismiss update notification"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
