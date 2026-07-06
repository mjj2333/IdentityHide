/**
 * Progress overlay shown during ComfyUI processing,
 * and error overlay with retry/skip/dismiss on failure.
 */
import DidYouKnowTip from './DidYouKnowTip';

export function ProgressOverlay({ progress, elapsed, onCancel, showTips = false }) {
  const pct = Math.round(progress * 100);
  return (
    <div className="apply-overlay">
      <div className="apply-overlay-inner">
        <div className="apply-progress-bar">
          <div className="apply-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="apply-status-text">{pct}%{elapsed > 0 ? ` (${elapsed}s)` : ''}</span>
        {showTips && elapsed >= 2 && <DidYouKnowTip />}
        <button className="btn btn-secondary btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ErrorOverlay({ error, onRetry, onSkip, onDismiss }) {
  return (
    <div className="apply-overlay">
      <div className="apply-overlay-inner apply-error-state">
        <div className="apply-error-icon">!</div>
        <p className="apply-error-message">{error}</p>
        <div className="apply-error-actions">
          <button className="btn btn-primary btn-small" onClick={onRetry}>
            Retry
          </button>
          {/* Skip and Dismiss are both de-emphasized (ghost) so Retry reads as
           * the unambiguous primary action. Skip is a destructive workaround
           * (proceeds without tattoo removal) and shouldn't compete for
           * attention with Retry on the error state. */}
          <button className="btn btn-ghost btn-small" onClick={onSkip}>
            Skip Tattoo Removal
          </button>
          <button className="btn btn-ghost btn-small" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
