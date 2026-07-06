import { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useEntitlement } from '../context/EntitlementContext';

/**
 * "Enter your email" modal. Used when a subscribed user is on a new device
 * and needs to restore premium, or when the paywall links to "Already
 * subscribed? Sign in".
 *
 * No password, no magic link. We just look up the email in the subscriptions
 * blob store. This is consistent with the trust-based client-side gate
 * documented in project_stripe memory.
 */
export default function SignInModal({ onClose, onSuccess }) {
  const modalRef = useRef(null);
  const inputRef = useRef(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { signIn } = useEntitlement();
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
    const email = value.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Please enter a valid email address.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { premium } = await signIn(email);
      if (premium) {
        onSuccess?.({ email, premium });
      } else {
        setError("We couldn't find an active subscription for that email.");
      }
    } catch (err) {
      console.warn('[SignIn] failed:', err.message);
      setError('Could not check subscription. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="confirm-backdrop" onClick={() => !busy && onClose?.()}>
      <div
        className="confirm-modal signin-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="signin-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="confirm-title" id="signin-title">Sign in</h3>
        <p className="confirm-message">
          Enter the email you used when subscribing. We'll check your subscription status.
        </p>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="email"
            className="signin-input"
            placeholder="you@example.com"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="email"
            disabled={busy}
            required
          />
          {error && <p className="paywall-error" role="alert">{error}</p>}
          <div className="confirm-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !value.trim()}>
              {busy ? 'Checking…' : 'Continue'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
