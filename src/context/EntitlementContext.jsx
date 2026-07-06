import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { fetchEntitlement, confirmFromSession } from '../utils/stripe';
import { getCreditState } from '../utils/credits';
import { track } from '../utils/analytics';

// Two credential types stored separately:
//   EMAIL_KEY: set by Stripe Checkout success, SignInModal, or admin manual
//              grants. Used for `?email=` entitlement lookups against the
//              `subscriptions` + `beta_redemptions` tables.
//   CODE_KEY:  set by self-service beta code redemption. Used for `?code=`
//              lookups against `beta_codes` directly (no per-user row).
// A user can in theory have both (e.g. subscribed then redeemed a code)
// and both are checked on mount; whichever grants premium "wins".
const EMAIL_KEY = 'ih_user_email';
const CODE_KEY = 'ih_beta_code';

// Short-lived cache of the last entitlement lookup. Avoids hitting the
// server on every app mount for users whose status is stable. 5-min TTL
// matches the existing Cache-Control on the entitlement endpoint —
// long enough to skip repeat fetches in a session, short enough that a
// user who upgrades/cancels via Stripe sees the change quickly.
const ENTITLEMENT_CACHE_KEY = 'ih_entitlement_cache';
const ENTITLEMENT_CACHE_TTL_MS = 5 * 60 * 1000;

function readEntitlementCache(targetEmail, targetCode) {
  try {
    const raw = sessionStorage.getItem(ENTITLEMENT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.email !== targetEmail || parsed.code !== targetCode) return null;
    if (Date.now() - (parsed.savedAt || 0) > ENTITLEMENT_CACHE_TTL_MS) return null;
    return parsed.result;
  } catch {
    return null;
  }
}

function writeEntitlementCache(targetEmail, targetCode, result) {
  try {
    sessionStorage.setItem(ENTITLEMENT_CACHE_KEY, JSON.stringify({
      email: targetEmail || null,
      code: targetCode || null,
      result,
      savedAt: Date.now(),
    }));
  } catch {}
}

function clearEntitlementCache() {
  try { sessionStorage.removeItem(ENTITLEMENT_CACHE_KEY); } catch {}
}

const EntitlementContext = createContext(null);

export function EntitlementProvider({ children }) {
  const [email, setEmail] = useState(() => {
    try { return localStorage.getItem(EMAIL_KEY) || null; } catch { return null; }
  });
  const [betaCode, setBetaCode] = useState(() => {
    try { return localStorage.getItem(CODE_KEY) || null; } catch { return null; }
  });
  const [premium, setPremium] = useState(false);
  const [expiresAt, setExpiresAt] = useState(null);
  // Which entitlement source is currently granting premium — 'stripe', 'beta',
  // or null. Surfaced so AccountScreen can show e.g. "Active via beta code".
  const [source, setSource] = useState(null);
  const [loading, setLoading] = useState(false);
  // Mirror credit state into React so components re-render when a credit is
  // consumed or earned. Source of truth is still localStorage (see credits.js).
  const [creditState, setCreditState] = useState(() => getCreditState());

  const syncCreditState = useCallback(() => {
    setCreditState(getCreditState());
  }, []);

  // Unified refresh: checks email first (if present), then code as fallback.
  // Stops at the first result that grants premium — a user with both a
  // Stripe subscription AND a beta code only needs one to confirm premium.
  //
  // The `forceFresh` opt-out skips the sessionStorage cache; callers that
  // need authoritative state (e.g. "Re-check status" button on AccountScreen,
  // post-redemption) pass true. Default false lets us serve from cache for
  // 5 minutes — saves a network round-trip on every mount.
  const refreshEntitlement = useCallback(async (override, { forceFresh = false } = {}) => {
    const targetEmail = override?.email ?? email;
    const targetCode = override?.code ?? betaCode;
    if (!targetEmail && !targetCode) {
      setPremium(false);
      setExpiresAt(null);
      setSource(null);
      clearEntitlementCache();
      return { premium: false, expiresAt: null, source: null };
    }
    if (!forceFresh) {
      const cached = readEntitlementCache(targetEmail || null, targetCode || null);
      if (cached) {
        setPremium(!!cached.premium);
        setExpiresAt(cached.expiresAt);
        setSource(cached.source || null);
        return cached;
      }
    }
    setLoading(true);
    try {
      let result = { premium: false, expiresAt: null, source: null };
      if (targetEmail) {
        result = await fetchEntitlement({ email: targetEmail });
      }
      if (!result.premium && targetCode) {
        result = await fetchEntitlement({ code: targetCode });
      }
      setPremium(!!result.premium);
      setExpiresAt(result.expiresAt);
      setSource(result.source || null);
      writeEntitlementCache(targetEmail || null, targetCode || null, {
        premium: !!result.premium,
        expiresAt: result.expiresAt,
        source: result.source || null,
      });
      return { premium: !!result.premium, expiresAt: result.expiresAt, source: result.source || null };
    } finally {
      setLoading(false);
    }
  }, [email, betaCode]);

  // Confirm a Stripe Checkout return given a session_id. Used by the mount
  // effect on web (reading window.location.search) and by the native deep
  // link handler when a Universal Link delivers the same URL post-purchase.
  const consumeStripeSuccess = useCallback(async (sessionId) => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const { email: landedEmail, premium: p, expiresAt: ea } = await confirmFromSession(sessionId);
      if (landedEmail) {
        try { localStorage.setItem(EMAIL_KEY, landedEmail); } catch {}
        setEmail(landedEmail);
      }
      setPremium(!!p);
      setExpiresAt(ea);
      // Stripe Checkout is the only caller of /success, so source is stripe.
      setSource(p ? 'stripe' : null);
      track('stripe_checkout_completed', { hasEmail: !!landedEmail, premium: !!p });
    } catch (err) {
      console.warn('[Entitlement] confirmFromSession failed:', err.message);
    } finally {
      setLoading(false);
      // Clean the address bar so a refresh doesn't re-fire the lookup.
      window.history.replaceState({ screen: 'drop' }, '', '/');
    }
  }, []);

  // Handle /success?session_id=... landing after Stripe Checkout.
  // Runs once on mount; replaces the URL so a refresh doesn't re-run.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    if (!sessionId || window.location.pathname !== '/success') return;
    consumeStripeSuccess(sessionId);
  }, [consumeStripeSuccess]);

  // Initial entitlement fetch if we have a cached credential from a previous visit.
  useEffect(() => {
    if (email || betaCode) refreshEntitlement();
    // Intentionally omit refreshEntitlement from deps — we only want to fire
    // this on mount, not on every function identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = useCallback(async (rawEmail) => {
    const normalized = String(rawEmail || '').trim().toLowerCase();
    if (!normalized) return { premium: false, expiresAt: null };
    try { localStorage.setItem(EMAIL_KEY, normalized); } catch {}
    setEmail(normalized);
    return refreshEntitlement({ email: normalized });
  }, [refreshEntitlement]);

  // Persist a successfully-redeemed beta code and refresh entitlement
  // against it. Called from RedeemCodeModal after /.netlify/functions/
  // redeem-beta-code returns premium:true.
  const signInWithCode = useCallback(async (rawCode) => {
    const normalized = String(rawCode || '').trim();
    if (!normalized) return { premium: false, expiresAt: null };
    try { localStorage.setItem(CODE_KEY, normalized); } catch {}
    setBetaCode(normalized);
    return refreshEntitlement({ code: normalized });
  }, [refreshEntitlement]);

  const signOut = useCallback(() => {
    try {
      localStorage.removeItem(EMAIL_KEY);
      localStorage.removeItem(CODE_KEY);
      localStorage.removeItem('ih_credits');
    } catch {}
    clearEntitlementCache();
    setEmail(null);
    setBetaCode(null);
    setPremium(false);
    setExpiresAt(null);
    setSource(null);
    setCreditState(getCreditState());
  }, []);

  // Permanent account deletion. Required by Play/App Store policy. Hits the
  // server to cancel any Stripe subscription + delete server-side rows, then
  // clears local credentials via signOut(). Throws on network/server error
  // so the UI can leave the user signed in and surface the failure.
  const deleteAccount = useCallback(async () => {
    const targetEmail = email || null;
    const targetCode = betaCode || null;
    if (!targetEmail && !targetCode) return;
    const { apiUrl } = await import('../utils/api.js');
    const res = await fetch(apiUrl('/.netlify/functions/delete-account'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: targetEmail, code: targetCode }),
    });
    if (!res.ok) {
      throw new Error(`Account deletion failed (${res.status})`);
    }
    signOut();
  }, [email, betaCode, signOut]);

  const value = useMemo(() => ({
    email, betaCode, premium, expiresAt, source, loading,
    creditState, syncCreditState,
    signIn, signInWithCode, signOut, deleteAccount, refreshEntitlement, consumeStripeSuccess,
  }), [email, betaCode, premium, expiresAt, source, loading, creditState, syncCreditState, signIn, signInWithCode, signOut, deleteAccount, refreshEntitlement, consumeStripeSuccess]);

  return (
    <EntitlementContext.Provider value={value}>
      {children}
    </EntitlementContext.Provider>
  );
}

export function useEntitlement() {
  const ctx = useContext(EntitlementContext);
  if (!ctx) throw new Error('useEntitlement must be used within EntitlementProvider');
  return ctx;
}
