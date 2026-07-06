import { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useEntitlement } from '../context/EntitlementContext';
import { redeemBetaCode } from '../utils/betaCodes';
import { track } from '../utils/analytics';

/**
 * Beta code redemption modal — visually unified with BetaWelcomeModal so
 * every "redeem a beta code" prompt across the app reads as the same
 * dialog. Differences from BetaWelcomeModal:
 *   - No "don't show again" checkbox (the user opened this explicitly)
 *   - "Cancel" instead of "Maybe later"
 *   - Backdrop click + Escape both dismiss (standard modal behavior)
 *
 * Admin manual grants flow through SignInModal instead — different
 * affordance for a different user journey.
 */
export default function RedeemCodeModal({ onClose, onSuccess }) {
  const modalRef = useRef(null);
  const inputRef = useRef(null);
  const { signInWithCode } = useEntitlement();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useFocusTrap(modalRef);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onCloseRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const trimmedCode = code.trim();
    if (!trimmedCode) {
      setError('Please enter your promo code.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await redeemBetaCode({ code: trimmedCode });
      track('beta_code_redeemed');
      await signInWithCode(trimmedCode);
      onSuccess?.();
    } catch (err) {
      const msg = (err?.message || '').trim();
      setError(msg && msg.length < 80 ? msg : 'Could not redeem code. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="confirm-backdrop" onClick={() => !busy && onClose?.()}>
      <div
        className="confirm-modal beta-welcome-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="redeem-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="beta-welcome-icon" aria-hidden="true">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5m4.75-11.396c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23-.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0 1 12 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
          </svg>
        </div>
        <h3 className="confirm-title beta-welcome-title" id="redeem-title">Redeem a promo code</h3>
        <p className="confirm-message beta-welcome-message">
          Enter your promo code for free access to unlimited tattoo removal, batch processing, and an ad-free experience.
        </p>
        <form onSubmit={handleSubmit} className="beta-welcome-form">
          <input
            ref={inputRef}
            type="text"
            className="signin-input redeem-code-input"
            placeholder="Enter your promo code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck="false"
            disabled={busy}
            aria-label="Promo code"
          />
          {error && <p className="paywall-error" role="alert">{error}</p>}
          <div className="beta-welcome-actions">
            <button
              type="submit"
              className="btn btn-primary btn-lg"
              disabled={busy || !code.trim()}
            >
              {busy ? 'Redeeming…' : 'Redeem code'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
