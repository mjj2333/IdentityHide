import { useState } from 'react';
import ScreenShell from './ScreenShell';
import RedeemCodeModal from './RedeemCodeModal';
import SignInModal from './SignInModal';
import SubscribeModal from './SubscribeModal';
import ConfirmModal from './ConfirmModal';
import { useEntitlement } from '../context/EntitlementContext';
import { openPortal } from '../utils/stripe';
import { isNativeApp } from '../utils/platform';

function formatExpiry(ms) {
  if (!ms) return null;
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric',
    });
  } catch {
    return null;
  }
}

export default function AccountScreen({ onBack }) {
  const { email, betaCode, premium, expiresAt, source, loading, signOut, deleteAccount, refreshEntitlement } = useEntitlement();
  const hasCredential = !!email || !!betaCode;
  const [busy, setBusy] = useState(false);
  const [showRedeem, setShowRedeem] = useState(false);
  const [error, setError] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);
  const [showSubscribe, setShowSubscribe] = useState(false);
  // Purchase UI is web-only; the store builds must not show a non-store
  // payment path. Promo redemption and sign-in stay available everywhere.
  const canPurchase = !isNativeApp();

  const handlePortal = async () => {
    if (busy || !email) return;
    setBusy(true);
    setError(null);
    try {
      await openPortal(email);
    } catch (err) {
      setError(err.message || 'Could not open billing portal.');
      setBusy(false);
    }
  };

  const handleSignOut = () => {
    if (busy) return;
    signOut();
  };

  const handleDeleteAccount = async () => {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteAccount();
      // signOut runs inside deleteAccount on success. Close the modal and
      // let the screen re-render in its no-credential state.
      setShowDeleteConfirm(false);
    } catch (err) {
      setError(err.message || 'Could not delete account. Please try again or contact support.');
    } finally {
      setDeleting(false);
    }
  };

  const expiryText = formatExpiry(expiresAt);

  return (
    <ScreenShell backAction={onBack} backLabel="Back">
      <div className="account-container">
        <h1 className="account-title">Account</h1>

        {!hasCredential && (
          <section className="account-section">
            <p>
              {canPurchase
                ? 'Go Premium for unlimited tattoo removal, full batch processing, and an ad-free experience.'
                : 'Redeem a promo code for access to unlimited tattoo removal, batch processing, and an ad-free experience.'}
            </p>
            <div className="account-actions">
              {canPurchase && (
                <button
                  className="btn btn-primary btn-lg"
                  onClick={() => setShowSubscribe(true)}
                  disabled={busy}
                >
                  Go Premium
                </button>
              )}
              <button
                className={`btn ${canPurchase ? 'btn-secondary' : 'btn-primary'} btn-lg`}
                onClick={() => setShowRedeem(true)}
                disabled={busy}
              >
                Redeem a promo code
              </button>
              {/* Sign-in restores a web (Stripe) subscription by email. Hidden
                  in the native shells: Apple 3.1.3(b) only permits accessing a
                  subscription bought elsewhere if it's also an in-app purchase,
                  and there's no IAP yet — so on iOS/Android premium comes via
                  promo codes only. Revisit when cross-platform IAP lands. */}
              {canPurchase && (
                <button
                  className="btn btn-ghost"
                  onClick={() => setShowSignIn(true)}
                  disabled={busy}
                >
                  Already subscribed? Sign in
                </button>
              )}
            </div>
          </section>
        )}

        {hasCredential && (
          <section className="account-section">
            <dl className="account-details">
              {email ? (
                <>
                  <dt>Email</dt>
                  <dd>{email}</dd>
                </>
              ) : (
                <>
                  <dt>Promo code</dt>
                  <dd className="account-beta-code">{betaCode}</dd>
                </>
              )}
              <dt>Status</dt>
              <dd>
                {loading ? 'Checking…' : (
                  premium
                    ? (
                      <span className="account-status account-status-active">
                        {source === 'beta' ? 'Active — promo' : 'Active'}
                      </span>
                    )
                    : <span className="account-status account-status-inactive">Inactive</span>
                )}
              </dd>
              {premium && expiryText && (
                <>
                  <dt>{source === 'beta' ? 'Access expires' : 'Next renewal'}</dt>
                  <dd>{expiryText}</dd>
                </>
              )}
            </dl>

            <div className="account-actions">
              {premium ? (
                source === 'stripe' && canPurchase ? (
                  // Billing portal is a Stripe (non-store) payment surface, so
                  // like the subscribe button it never renders in the native
                  // shells. Web-subscribed users manage billing on the web.
                  <button
                    className="btn btn-primary btn-lg"
                    onClick={handlePortal}
                    disabled={busy}
                  >
                    Manage subscription
                  </button>
                ) : (
                  // Code-granted access has no Stripe Customer to manage. We
                  // deliberately don't promote a paid upgrade path here — the
                  // user is already premium via their promo code, that's the
                  // relationship we want to honor.
                  null
                )
              ) : (
                <>
                  {canPurchase && (
                    <button
                      className="btn btn-primary btn-lg"
                      onClick={() => setShowSubscribe(true)}
                      disabled={busy}
                    >
                      Go Premium
                    </button>
                  )}
                  <button
                    className={`btn ${canPurchase ? 'btn-secondary' : 'btn-primary'} btn-lg`}
                    onClick={() => setShowRedeem(true)}
                    disabled={busy}
                  >
                    Redeem a promo code
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => refreshEntitlement(undefined, { forceFresh: true })}
                    disabled={busy}
                  >
                    Re-check status
                  </button>
                </>
              )}
              <button
                className="btn btn-ghost"
                onClick={handleSignOut}
                disabled={busy}
              >
                Sign out
              </button>
              <button
                className="btn btn-ghost account-delete-btn"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={busy || deleting}
              >
                Delete account
              </button>
            </div>
          </section>
        )}

        {error && <p className="paywall-error" role="alert">{error}</p>}

        {showRedeem && (
          <RedeemCodeModal
            onClose={() => setShowRedeem(false)}
            onSuccess={() => setShowRedeem(false)}
          />
        )}

        {showSignIn && (
          <SignInModal
            onClose={() => setShowSignIn(false)}
            onSuccess={() => setShowSignIn(false)}
          />
        )}

        {showSubscribe && (
          <SubscribeModal
            source="account"
            onClose={() => setShowSubscribe(false)}
          />
        )}

        {showDeleteConfirm && (
          <ConfirmModal
            message={
              email
                ? 'Permanently delete your account? Your subscription (if any) will be cancelled and your data on our servers will be removed. This cannot be undone.'
                : 'Permanently delete your account? Your promo code will be removed from this device. This cannot be undone.'
            }
            confirmLabel={deleting ? 'Deleting…' : 'Delete account'}
            onConfirm={handleDeleteAccount}
            onCancel={() => { if (!deleting) setShowDeleteConfirm(false); }}
          />
        )}
      </div>
    </ScreenShell>
  );
}
