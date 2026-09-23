import { useState, useRef, useEffect } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { openCheckout } from '../utils/stripe';
import { useEntitlement } from '../context/EntitlementContext';
import { track } from '../utils/analytics';
import { isNativeApp } from '../utils/platform';

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
  // The email goes to the server BEFORE Stripe so it can refuse a second
  // purchase for an email that already subscribes (each checkout would
  // otherwise start a brand-new Stripe customer + subscription — a signed-out
  // subscriber re-buying is exactly how the duplicates happened) and lock
  // that email on the Checkout page. Signed out, we ask for it here.
  const { email: knownEmail, signIn } = useEntitlement();
  const [typedEmail, setTypedEmail] = useState('');
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
    const email = (knownEmail || typedEmail).trim().toLowerCase();
    if (!knownEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Please enter a valid email address.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Redirects the browser to Stripe Checkout on success; only returns
      // control here on failure.
      await openCheckout(plan, { email });
    } catch (err) {
      console.warn('[Subscribe] checkout failed:', err.message);
      if (err.code === 'already_subscribed') {
        // They already pay for this. Signed out: sign them in with that
        // email instead of taking their money again. Signed in: the row is
        // stale — Re-check status on the Account screen repairs it.
        if (!knownEmail) {
          try {
            const { premium } = await signIn(email);
            if (premium) { onCloseRef.current?.(); return; }
          } catch (signInErr) {
            console.warn('[Subscribe] sign-in after 409 failed:', signInErr.message);
          }
        }
        setError(`${email} already has an active subscription. Use "Re-check status" on the Account screen, or Manage subscription to review it.`);
      } else {
        setError('Could not open checkout. Please try again in a moment.');
      }
      setBusy(false);
    }
  };

  const handleDismiss = () => {
    if (busy) return;
    onClose?.();
  };

  // Apple 3.1.1: the Stripe (non-store) purchase path must not exist on the
  // native builds. Every caller already gates on !isNativeApp(); this is
  // defense in depth so no future opener can surface it on the store build.
  if (isNativeApp()) return null;

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

        {!knownEmail && (
          <label className="subscribe-email">
            <span className="subscribe-email-label">Email for your subscription</span>
            <input
              type="email"
              className="signin-input"
              placeholder="you@example.com"
              value={typedEmail}
              onChange={(e) => setTypedEmail(e.target.value)}
              autoComplete="email"
              disabled={busy}
              required
            />
          </label>
        )}

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
