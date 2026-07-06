import { useState, useRef, useEffect } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { openCheckout } from '../utils/stripe';
import { track } from '../utils/analytics';

/**
 * Subscription plan picker -> Stripe hosted Checkout.
 *
 * Web only: every mount point gates on !isNativeApp() because the Play/App
 * Store builds must not show a non-store purchase path (store billing
 * policies). Display prices live here as plain strings; the amount actually
 * charged is whatever the Stripe Price object says, resolved server-side by
 * stripe-checkout.js from STRIPE_PRICE_MONTHLY / STRIPE_PRICE_ANNUAL.
 */
const PLANS = [
  {
    key: 'annual',
    name: 'Annual',
    price: '$39.99',
    per: '/year',
    badge: '2 months free',
    note: 'Billed annually vs $3.99/month',
  },
  {
    key: 'monthly',
    name: 'Monthly',
    price: '$3.99',
    per: '/month',
    note: 'Cancel anytime',
  },
];

export default function SubscribeModal({ onClose, source = 'unknown' }) {
  const modalRef = useRef(null);
  const [plan, setPlan] = useState('annual');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useFocusTrap(modalRef);

  useEffect(() => {
    track('subscribe_modal_shown', { source });
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onCloseRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  const handleSubscribe = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Redirects the browser to Stripe Checkout on success; only returns
      // control here on failure.
      await openCheckout(plan);
    } catch (err) {
      console.warn('[Subscribe] checkout failed:', err.message);
      setError('Could not open checkout. Please try again in a moment.');
      setBusy(false);
    }
  };

  const handleDismiss = () => {
    if (busy) return;
    onClose?.();
  };

  return (
    <div className="confirm-backdrop" onClick={handleDismiss}>
      <div
        className="confirm-modal subscribe-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="subscribe-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="confirm-title" id="subscribe-title">Go Premium</h3>
        <p className="confirm-message subscribe-sub">
          Unlimited AI tattoo removal, full 20-image batches, and no ads.
        </p>

        <div className="subscribe-plans" role="radiogroup" aria-label="Choose a plan">
          {PLANS.map((p) => {
            const selected = plan === p.key;
            return (
              <button
                key={p.key}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`subscribe-plan${selected ? ' is-selected' : ''}`}
                onClick={() => setPlan(p.key)}
                disabled={busy}
              >
                <span className="subscribe-plan-head">
                  <span className="subscribe-plan-name">{p.name}</span>
                  {p.badge && <span className="subscribe-plan-badge">{p.badge}</span>}
                </span>
                <span className="subscribe-plan-price">
                  {p.price}<span className="subscribe-plan-per">{p.per}</span>
                </span>
                <span className="subscribe-plan-note">{p.note}</span>
              </button>
            );
          })}
        </div>

        <div className="subscribe-actions">
          <button
            className="btn btn-primary btn-lg"
            onClick={handleSubscribe}
            disabled={busy}
          >
            {busy ? 'Opening checkout…' : 'Subscribe'}
          </button>
        </div>

        {error && <p className="paywall-error" role="alert">{error}</p>}

        <p className="subscribe-fineprint">
          Prices in CAD. Secure checkout by Stripe. Cancel anytime from your account.
        </p>

        <div className="paywall-footer">
          <button className="paywall-link" onClick={handleDismiss} disabled={busy}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
