import { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { showRewardedAd } from '../utils/rewardedAd';
import { grantRewardedCredit, canEarnMore, MAX_EARNED_PER_WEEK } from '../utils/credits';
import { track } from '../utils/analytics';

/**
 * Paywall shown when a free user runs out of tattoo-removal credits.
 * Two paths:
 *   - Redeem a beta code (delegates to caller via onRedeemClick)
 *   - Watch ad (if credits earnable today) → grants +1 credit on completion
 *
 * Subscribe references are intentionally absent during beta — the only
 * paid path users see is Stripe Checkout from the Account screen, never
 * promoted from gates or paywalls.
 *
 * `onEarnedCredit` fires when the rewarded ad completes and +1 was granted,
 * so the caller (MaskEditorScreen) can re-check canConsumeCredit and
 * proceed with the Apply it had queued.
 */
export default function PaywallModal({ onClose, onEarnedCredit, onRedeemClick }) {
  const modalRef = useRef(null);
  const primaryRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useFocusTrap(modalRef);

  useEffect(() => {
    primaryRef.current?.focus();
    track('paywall_shown');
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onCloseRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy]);

  const canWatchAd = canEarnMore();
  const handleWatchAd = async () => {
    if (busy || !canWatchAd) return;
    setBusy(true);
    setError(null);
    track('paywall_watched_ad');
    try {
      const { completed } = await showRewardedAd();
      if (completed) {
        grantRewardedCredit();
        track('credit_earned');
        onEarnedCredit?.();
      } else {
        setError('Ad was not completed — no credit earned.');
      }
    } catch (err) {
      console.warn('[Paywall] rewarded ad failed:', err.message);
      setError('Ad could not be shown. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = () => {
    if (busy) return;
    track('paywall_dismissed');
    onClose?.();
  };

  return (
    <div className="confirm-backdrop" onClick={handleDismiss}>
      <div
        className="confirm-modal paywall-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="paywall-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="confirm-title" id="paywall-title">Out of tattoo credits</h3>
        <p className="confirm-message">
          You've used all your free tattoo removals for this week. Redeem a promo code to unlock everything, or watch a short ad for one more credit.
        </p>

        <div className="paywall-actions">
          {onRedeemClick && (
            <button
              ref={primaryRef}
              className="btn btn-primary btn-lg"
              onClick={onRedeemClick}
              disabled={busy}
            >
              Redeem a promo code
            </button>
          )}
          <button
            className="btn btn-secondary btn-lg"
            onClick={handleWatchAd}
            disabled={busy || !canWatchAd}
            title={canWatchAd ? 'Watch a short ad for +1 tattoo credit' : `You've reached the weekly cap of ${MAX_EARNED_PER_WEEK} earned credits`}
          >
            {canWatchAd ? 'Watch ad for +1 credit' : `Weekly ad cap reached (${MAX_EARNED_PER_WEEK})`}
          </button>
        </div>

        {error && <p className="paywall-error" role="alert">{error}</p>}

        <div className="paywall-footer">
          <button className="paywall-link" onClick={handleDismiss} disabled={busy}>
            Later
          </button>
        </div>
      </div>
    </div>
  );
}
