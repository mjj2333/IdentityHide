import { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { showRewardedAd } from '../utils/rewardedAd';
import { grantRewardedCredit, canEarnMore, MAX_EARNED_PER_WEEK } from '../utils/credits';
import { isNativeApp } from '../utils/platform';
import { track } from '../utils/analytics';

/**
 * Paywall shown when a free user runs out of tattoo-removal credits.
 * Three paths:
 *   - Subscribe (web only — delegates to caller via onSubscribeClick; the
 *     native shells must not show a non-store purchase path)
 *   - Watch ad (if credits earnable this week) → grants +1 credit on completion
 *   - Redeem a promo code (delegates to caller via onRedeemClick)
 *
 * `onEarnedCredit` fires when the rewarded ad completes and +1 was granted,
 * so the caller (MaskEditorScreen) can re-check canConsumeCredit and
 * proceed with the Apply it had queued.
 */
export default function PaywallModal({ onClose, onEarnedCredit, onRedeemClick, onSubscribeClick }) {
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
  // Subscribe is web-only: the Play/App Store builds must not surface a
  // non-store purchase path, so the button simply never renders there.
  const showSubscribe = !!onSubscribeClick && !isNativeApp();
  // Promo-code redemption is likewise a non-IAP unlock (Apple 3.1.1) — hide it
  // on native. Rewarded ads and "Later" remain the native paths.
  const showRedeem = !!onRedeemClick && !isNativeApp();
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
          {showSubscribe
            ? "You've used all your free tattoo removals for this week. Go Premium for unlimited removals, or watch a short ad for one more credit."
            : "You've used all your free tattoo removals for this week. Watch a short ad for one more credit."}
        </p>

        <div className="paywall-actions">
          {showSubscribe && (
            <button
              ref={primaryRef}
              className="btn btn-primary btn-lg"
              onClick={onSubscribeClick}
              disabled={busy}
            >
              Go Premium for unlimited removals
            </button>
          )}
          <button
            ref={showSubscribe ? undefined : primaryRef}
            className={`btn ${showSubscribe ? 'btn-secondary' : 'btn-primary'} btn-lg`}
            onClick={handleWatchAd}
            disabled={busy || !canWatchAd}
            title={canWatchAd ? 'Watch a short ad for +1 tattoo credit' : `You've reached the weekly cap of ${MAX_EARNED_PER_WEEK} earned credits`}
          >
            {canWatchAd ? 'Watch ad for +1 credit' : `Weekly ad cap reached (${MAX_EARNED_PER_WEEK})`}
          </button>
          {showRedeem && (
            <button
              className="btn btn-ghost btn-lg"
              onClick={onRedeemClick}
              disabled={busy}
            >
              Redeem a promo code
            </button>
          )}
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
