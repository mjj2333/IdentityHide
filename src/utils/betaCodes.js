/**
 * Client-side helper for redeeming a beta code.
 *
 * Kept separate from stripe.js because beta codes are a distinct
 * entitlement source (server-side they're a second table; client-side
 * the redeem flow doesn't overlap with Stripe Checkout at all).
 */

import { apiUrl } from './api';

const REDEEM_ENDPOINT = apiUrl('/.netlify/functions/redeem-beta-code');

/**
 * POST { code } → { code, premium, expiresAt, source: 'beta' }
 * The code is the credential — no email required. The server echoes the
 * plaintext back so the client can persist it for future entitlement checks.
 * Throws on network errors or non-2xx responses. The server deliberately
 * uses the same "Invalid code" message for unknown/revoked/expired codes
 * so brute forcers can't distinguish the failure modes.
 */
export async function redeemBetaCode({ code }) {
  const res = await fetch(REDEEM_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Redemption failed (${res.status})`);
  }
  return res.json();
}
