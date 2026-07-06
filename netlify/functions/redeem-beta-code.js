// Redeem a beta code. The code itself is the credential — no email required.
//
// Flow:
//   1. Hash the submitted code (SHA-256 of trimmed+uppercased).
//   2. Look up the hash in `beta_codes` — reject if missing, revoked, or
//      the code itself is past its expiry.
//   3. Atomically increment `beta_codes.redemption_count` so the admin
//      dashboard can see how popular each code is. No per-user row is
//      written — the code itself is the credential.
//   4. Return { premium, expiresAt, code, source: 'beta' }.
//
// Admin manual grants (the "Grant access directly by email" form in the
// admin dashboard) still write to `beta_redemptions` with code_id=null;
// those users sign in by email and the entitlement endpoint finds them
// via the email path. This endpoint is for self-service code redemption
// only.
//
// No HMAC token is issued — the server is the source of truth on every
// subsequent entitlement check, so there's nothing for a forger to bypass.
//
// Rate-limited to 10 requests/min/IP to slow down code brute-forcing.
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { rateLimit, checkOrigin } from './rateLimit.js';
import { withSentry, captureException } from './_sentry.js';
import { withCors } from './_cors.js';

let supabase;
function getSupabase() {
  if (!supabase) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabase;
}

function hashCode(plaintext) {
  return createHash('sha256').update(String(plaintext).trim().toUpperCase(), 'utf8').digest('hex');
}

async function redeemBetaCodeHandler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: {} };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const origin = checkOrigin(event);
  if (origin.rejected) return origin.response;

  const rl = await rateLimit(event, 10);
  if (rl.limited) return rl.response;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const rawCode = typeof body.code === 'string' ? body.code.trim() : '';
  if (!rawCode || rawCode.length > 64) {
    return { statusCode: 400, body: 'Invalid code' };
  }

  const code_hash = hashCode(rawCode);

  // Look up the code. Deliberately opaque error message ("Invalid code") for
  // all failure modes — not-found, revoked, expired — so brute forcers can't
  // distinguish "wrong code" from "valid but expired" via the response.
  let codeRow;
  try {
    const { data, error } = await getSupabase()
      .from('beta_codes')
      .select('id, expires_at, revoked')
      .eq('code_hash', code_hash)
      .maybeSingle();
    if (error) throw error;
    codeRow = data;
  } catch (err) {
    captureException(err, { context: 'redeem-beta-code.lookup' });
    return { statusCode: 500, body: 'Redemption unavailable' };
  }

  const now = Date.now();
  const codeValid = codeRow
    && !codeRow.revoked
    && (!codeRow.expires_at || new Date(codeRow.expires_at).getTime() > now);
  if (!codeValid) {
    return { statusCode: 400, body: 'Invalid code' };
  }

  // Bump the aggregate redemption counter. Intentionally non-fatal if it
  // fails — the redemption itself is still valid, we just miss the analytics
  // tick. Uses a raw increment via RPC so concurrent redemptions don't race.
  try {
    await getSupabase().rpc('increment_beta_code_redemptions', { p_code_id: codeRow.id });
  } catch (err) {
    // If the RPC doesn't exist yet (pre-migration), fall back to a
    // read-modify-write. Still non-fatal if both fail.
    try {
      const { data: current } = await getSupabase()
        .from('beta_codes')
        .select('redemption_count')
        .eq('id', codeRow.id)
        .maybeSingle();
      const next = (current?.redemption_count || 0) + 1;
      await getSupabase()
        .from('beta_codes')
        .update({ redemption_count: next })
        .eq('id', codeRow.id);
    } catch (err2) {
      captureException(err2, { context: 'redeem-beta-code.counter' });
    }
  }

  const expiresAtISO = codeRow.expires_at || null;
  const expiresAtMs = expiresAtISO ? new Date(expiresAtISO).getTime() : null;
  const premium = !expiresAtMs || expiresAtMs > now;

  // Echo the plaintext code back so the client can persist it in
  // localStorage and re-check entitlement on future visits without
  // asking the user to type it again.
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: rawCode, premium, expiresAt: expiresAtMs, source: 'beta' }),
  };
}

export const handler = withCors(withSentry(redeemBetaCodeHandler));
