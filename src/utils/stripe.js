/**
 * Client-side Stripe helpers. Uses hosted Checkout + Billing Portal — no
 * @stripe/stripe-js dependency needed.
 */

import { track } from './analytics';
import { apiUrl } from './api';

const CHECKOUT_ENDPOINT = apiUrl('/.netlify/functions/stripe-checkout');
const PORTAL_ENDPOINT = apiUrl('/.netlify/functions/customer-portal');
const ENTITLEMENT_ENDPOINT = apiUrl('/.netlify/functions/entitlement');
const SESSION_ENDPOINT = apiUrl('/.netlify/functions/entitlement-from-session');

/**
 * Start a Stripe Checkout session and redirect the browser to it.
 * `priceKey` is 'monthly' or 'annual' — resolved to a Price ID on the server.
 */
export async function openCheckout(priceKey) {
  track('stripe_checkout_opened', { priceKey });
  const res = await fetch(CHECKOUT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priceKey }),
  });
  if (!res.ok) {
    throw new Error(`Checkout unavailable (${res.status})`);
  }
  const { url } = await res.json();
  window.location.href = url;
}

/**
 * Open the Stripe Billing Portal for a subscribed email. Redirects the
 * browser on success. Throws if the email doesn't have an active
 * subscription row.
 */
export async function openPortal(email) {
  const res = await fetch(PORTAL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    throw new Error(`Portal unavailable (${res.status})`);
  }
  const { url } = await res.json();
  window.location.href = url;
}

/**
 * Look up whether the caller currently has premium. Accepts either an
 * email (for Stripe subscribers and admin-granted users) or a beta code
 * (for self-service redemption). Always resolves to a shape — falls back
 * to { premium: false } on any error so callers don't have to branch on
 * network failure.
 *
 * @param {{ email?: string, code?: string } | string} arg - object with
 *   email or code, or a bare string treated as an email (back-compat).
 */
export async function fetchEntitlement(arg) {
  // Back-compat: earlier callers pass a bare email string.
  const spec = typeof arg === 'string' ? { email: arg } : (arg || {});
  let url = ENTITLEMENT_ENDPOINT;
  if (spec.code) {
    url += `?code=${encodeURIComponent(spec.code)}`;
  } else if (spec.email) {
    url += `?email=${encodeURIComponent(spec.email)}`;
  } else {
    return { premium: false, expiresAt: null, source: null };
  }
  try {
    const res = await fetch(url);
    if (!res.ok) return { premium: false, expiresAt: null, source: null };
    return await res.json();
  } catch {
    return { premium: false, expiresAt: null, source: null };
  }
}

/**
 * Used on the /success?session_id=… landing page. Resolves the Checkout
 * Session server-side, returns the email + entitlement. Throws on error so
 * the caller can decide what to show.
 */
export async function confirmFromSession(sessionId) {
  const res = await fetch(`${SESSION_ENDPOINT}?session_id=${encodeURIComponent(sessionId)}`);
  if (!res.ok) {
    throw new Error(`Session lookup failed (${res.status})`);
  }
  return res.json();
}
