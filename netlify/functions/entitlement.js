// Returns whether the caller is premium. Supports two credentials:
//
//   GET ?email=foo@bar.com  → checks `subscriptions` + `beta_redemptions`
//                             (Stripe subscribers and admin manual grants)
//   GET ?code=REDACT-XXXX   → checks `beta_codes` directly (self-service
//                             beta code redemption — no row per user)
//
// Response shape: { premium: boolean, expiresAt: number | null, source: 'stripe' | 'beta' | null }
// Privacy note: we don't leak whether an email/code is known vs unknown —
// all failure modes return `{ premium: false, expiresAt: null, source: null }`.
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { rateLimit, checkOrigin } from './rateLimit.js';
import { withSentry } from './_sentry.js';
import { withCors } from './_cors.js';

let supabase;
function getSupabase() {
  if (!supabase) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabase;
}

function emailKey(email) {
  return String(email || '').trim().toLowerCase();
}

function hashCode(plaintext) {
  return createHash('sha256').update(String(plaintext).trim().toUpperCase(), 'utf8').digest('hex');
}

const NOT_PREMIUM = {
  statusCode: 200,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'private, max-age=60',
  },
  body: JSON.stringify({ premium: false, expiresAt: null, source: null }),
};

async function lookupByCode(rawCode) {
  const code_hash = hashCode(rawCode);
  try {
    const { data, error } = await getSupabase()
      .from('beta_codes')
      .select('expires_at, revoked')
      .eq('code_hash', code_hash)
      .maybeSingle();
    if (error) throw error;
    if (!data || data.revoked) return NOT_PREMIUM;
    const now = Date.now();
    const expiresAtMs = data.expires_at ? new Date(data.expires_at).getTime() : null;
    if (expiresAtMs !== null && expiresAtMs <= now) return NOT_PREMIUM;
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=60',
      },
      body: JSON.stringify({ premium: true, expiresAt: expiresAtMs, source: 'beta' }),
    };
  } catch (err) {
    console.error('[entitlement] code lookup failed:', err.message);
    return NOT_PREMIUM;
  }
}

async function lookupByEmail(email) {
  // Query both entitlement sources in parallel — Stripe subscription and
  // admin-granted beta redemption. Either can grant premium; the two
  // tables are independent so a user can have both without collision.
  let subRow = null;
  let betaRow = null;
  try {
    const [subRes, betaRes] = await Promise.all([
      getSupabase()
        .from('subscriptions')
        .select('status, current_period_end')
        .eq('email', email)
        .maybeSingle(),
      getSupabase()
        .from('beta_redemptions')
        .select('expires_at')
        .eq('email', email)
        .maybeSingle(),
    ]);
    if (subRes.error) throw subRes.error;
    if (betaRes.error) throw betaRes.error;
    subRow = subRes.data;
    betaRow = betaRes.data;
  } catch (err) {
    console.error('[entitlement] db read failed:', err.message);
    // Fail closed on premium — better to show paywall on infra hiccups than
    // accidentally grant free access.
    return NOT_PREMIUM;
  }

  const now = Date.now();

  // Stripe side: active if status is active/trialing/canceled AND the period
  // hasn't expired. Canceled + future period_end = cancel-at-period-end.
  const subStatus = subRow?.status;
  const subExpires = subRow?.current_period_end || null;
  const subActive = (subStatus === 'active' || subStatus === 'trialing' || subStatus === 'canceled')
    && subExpires && subExpires > now;

  // Beta side: active if a redemption row exists and its expiry is either
  // null (indefinite) or in the future. Redemptions table is keyed by email.
  const betaExpiresISO = betaRow?.expires_at || null;
  const betaExpiresMs = betaExpiresISO ? new Date(betaExpiresISO).getTime() : null;
  const betaActive = !!betaRow && (betaExpiresMs === null || betaExpiresMs > now);

  // Premium if EITHER source grants it. Stripe wins the `source` tag when
  // both are active since paid access is the "primary" entitlement — beta
  // is a gift on top. `expiresAt` is whichever grants access longer.
  const premium = subActive || betaActive;
  let source = null;
  let expiresAt = null;
  if (subActive && betaActive) {
    source = 'stripe';
    const candidateA = subExpires;
    const candidateB = betaExpiresMs ?? Infinity;
    expiresAt = Math.max(candidateA, candidateB);
    if (!Number.isFinite(expiresAt)) expiresAt = null;
  } else if (subActive) {
    source = 'stripe';
    expiresAt = subExpires;
  } else if (betaActive) {
    source = 'beta';
    expiresAt = betaExpiresMs;
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, max-age=60',
    },
    body: JSON.stringify({ premium, expiresAt, source }),
  };
}

async function entitlementHandler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: {} };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const origin = checkOrigin(event);
  if (origin.rejected) return origin.response;

  const rl = await rateLimit(event, 30);
  if (rl.limited) return rl.response;

  // Code path takes precedence — if both are sent (edge case), the code is
  // what the user actively holds, so prefer it.
  const rawCode = typeof event.queryStringParameters?.code === 'string'
    ? event.queryStringParameters.code.trim()
    : '';
  if (rawCode) {
    if (rawCode.length > 64) return { statusCode: 400, body: 'Invalid code' };
    return lookupByCode(rawCode);
  }

  const email = emailKey(event.queryStringParameters?.email);
  if (!email || email.length > 254) {
    return { statusCode: 400, body: 'Invalid email' };
  }
  return lookupByEmail(email);
}

export const handler = withCors(withSentry(entitlementHandler));
