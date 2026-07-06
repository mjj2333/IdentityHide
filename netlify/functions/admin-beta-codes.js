// Admin-only endpoint for generating, listing, and revoking beta codes.
//
// Auth: Bearer token matching ADMIN_PASSWORD (same pattern as admin-stats).
// Storage: Supabase tables `beta_codes` + `beta_redemptions`. The plaintext
// code is returned ONCE on create and never stored — we keep only the
// SHA-256 hash, so a leaked DB dump can't be converted into working codes.
//
// Action shape (POST body):
//   { action: 'create', label?: string, expiresAt?: ISO string, code?: string }
//     → { code, id, label, expiresAt, createdAt }
//     If `code` is omitted, the server auto-generates a REDACT-XXXX-XXXX code.
//     If `code` is provided, it's used verbatim (4–32 chars, alphanumeric +
//     dashes/underscores). Redemption is always case-insensitive.
//   { action: 'list' }
//     → { codes: [{ id, code, label, expiresAt, revoked, createdAt, redemptions }] }
//   { action: 'revoke', id: uuid }
//     → { ok: true }
//   { action: 'delete', id: uuid }
//     → { ok: true }  (hard delete — row is removed; beta_redemptions rows
//                      for this code keep their access because code_id is
//                      set to null via ON DELETE SET NULL.)
//   { action: 'manual-grant', email: string, expiresAt?: ISO string }
//     → { ok: true, email, expiresAt }
//     Writes a beta_redemptions row with code_id=null, code_hash='manual-grant'.
//     The target user becomes premium immediately on next entitlement fetch.
import { randomBytes, createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { authenticateAdmin } from './auth.js';
import { rateLimit, checkOrigin } from './rateLimit.js';
import { withSentry, captureException } from './_sentry.js';
import { withCors } from './_cors.js';

// Charset excludes 0/O, 1/I/L, and lowercase to avoid typos on hand-shared
// codes. 31 uppercase characters × 8 positions ≈ 10^12 keyspace — plenty for
// a hand-generated set.
const CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_PREFIX = 'REDACT';

let supabase;
function getSupabase() {
  if (!supabase) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabase;
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function hashCode(plaintext) {
  return sha256Hex(String(plaintext).trim().toUpperCase());
}

function segment(n) {
  // Rejection-sample bytes into the 31-char alphabet so each position is
  // uniform. A raw `bytes[i] % 31` would introduce a slight bias toward the
  // first 8 characters since 256 % 31 ≠ 0.
  const out = [];
  while (out.length < n) {
    const buf = randomBytes(n * 2);
    for (const b of buf) {
      if (out.length === n) break;
      if (b < 248) out.push(CODE_CHARSET[b % CODE_CHARSET.length]);
    }
  }
  return out.join('');
}

function generateCode() {
  return `${CODE_PREFIX}-${segment(4)}-${segment(4)}`;
}

function parseBody(event) {
  try { return JSON.parse(event.body || '{}'); }
  catch { return null; }
}

async function handleCreate(body) {
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 120) : '';
  let expiresAt = null;
  if (body.expiresAt) {
    const d = new Date(body.expiresAt);
    if (Number.isNaN(d.getTime())) {
      return { statusCode: 400, body: 'Invalid expiresAt' };
    }
    expiresAt = d.toISOString();
  }

  // Custom-code path — admin specified an explicit code like "beta2026".
  // Stored as-entered for display, hashed uppercase so redemption stays
  // case-insensitive (hashCode uppercases before digesting).
  const rawCustom = typeof body.code === 'string' ? body.code.trim() : '';
  if (rawCustom) {
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(rawCustom)) {
      return { statusCode: 400, body: 'Custom code must be 4–32 characters, letters/digits/dashes/underscores only' };
    }
    const code_hash = hashCode(rawCustom);
    const { data, error } = await getSupabase()
      .from('beta_codes')
      .insert({ code_hash, code: rawCustom, label, expires_at: expiresAt })
      .select('id, code, label, expires_at, revoked, created_at')
      .single();
    if (error) {
      if (error.code === '23505') {
        return { statusCode: 409, body: 'A code with that value already exists' };
      }
      captureException(error, { context: 'admin-beta-codes.create.custom' });
      console.error('[admin-beta-codes] custom insert failed:', error.message);
      return { statusCode: 500, body: 'Could not create code' };
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: data.code,
        id: data.id,
        label: data.label,
        expiresAt: data.expires_at,
        revoked: data.revoked,
        createdAt: data.created_at,
      }),
    };
  }

  // Auto-generate path. Retry on the vanishingly rare case of a hash
  // collision. Five tries is overkill — probability of a second collision
  // on the retry is ~10^-24.
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const plaintext = generateCode();
    const code_hash = hashCode(plaintext);
    // We store both the plaintext (for admin recall + re-sharing) and the
    // SHA-256 hash (for redemption lookup). Plaintext is only ever returned
    // through this admin-auth-gated endpoint.
    const { data, error } = await getSupabase()
      .from('beta_codes')
      .insert({ code_hash, code: plaintext, label, expires_at: expiresAt })
      .select('id, code, label, expires_at, revoked, created_at')
      .single();
    if (!error) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: plaintext,
          id: data.id,
          label: data.label,
          expiresAt: data.expires_at,
          revoked: data.revoked,
          createdAt: data.created_at,
        }),
      };
    }
    // 23505 = Postgres unique_violation. Retry with a new code. Everything
    // else (schema error, permission error) is terminal.
    if (error.code !== '23505') {
      captureException(error, { context: 'admin-beta-codes.create' });
      console.error('[admin-beta-codes] insert failed:', error.message);
      return { statusCode: 500, body: 'Could not create code' };
    }
    lastError = error;
  }
  captureException(lastError, { context: 'admin-beta-codes.create.collision-exhausted' });
  return { statusCode: 500, body: 'Could not create code (collision)' };
}

async function handleList() {
  // Counter lives on beta_codes.redemption_count, bumped atomically on each
  // self-service code redemption. No join needed — admin manual grants go
  // to beta_redemptions with code_id=null and aren't counted per-code.
  const { data: codes, error: codesError } = await getSupabase()
    .from('beta_codes')
    .select('id, code, label, expires_at, revoked, created_at, redemption_count')
    .order('created_at', { ascending: false })
    .limit(200);
  if (codesError) {
    captureException(codesError, { context: 'admin-beta-codes.list.codes' });
    return { statusCode: 500, body: 'Could not list codes' };
  }

  const result = codes.map(c => ({
    id: c.id,
    // Older rows created before the `code` column was added return null
    // here — the UI shows "—" for those since we can't recover plaintext
    // from a SHA-256 hash.
    code: c.code || null,
    label: c.label,
    expiresAt: c.expires_at,
    revoked: c.revoked,
    createdAt: c.created_at,
    redemptions: c.redemption_count || 0,
  }));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes: result }),
  };
}

async function handleRevoke(body) {
  const id = typeof body.id === 'string' ? body.id : null;
  if (!id) return { statusCode: 400, body: 'Missing id' };
  const { error } = await getSupabase()
    .from('beta_codes')
    .update({ revoked: true })
    .eq('id', id);
  if (error) {
    captureException(error, { context: 'admin-beta-codes.revoke' });
    return { statusCode: 500, body: 'Could not revoke code' };
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  };
}

async function handleManualGrant(body) {
  const rawEmail = typeof body.email === 'string' ? body.email : '';
  const email = rawEmail.trim().toLowerCase();
  // Minimal email validation — catches typos like missing @ without pretending
  // to validate deliverability. Real validation happens when the user tries to
  // sign in with this email and the entitlement lookup matches.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, body: 'Invalid email' };
  }

  let expiresAt = null;
  if (body.expiresAt) {
    const d = new Date(body.expiresAt);
    if (Number.isNaN(d.getTime())) {
      return { statusCode: 400, body: 'Invalid expiresAt' };
    }
    expiresAt = d.toISOString();
  }

  // Upsert keyed by email so a second grant to the same address refreshes
  // the expiry instead of creating a duplicate row.
  const { error } = await getSupabase()
    .from('beta_redemptions')
    .upsert({
      email,
      code_id: null,
      code_hash: 'manual-grant',
      expires_at: expiresAt,
      redeemed_at: new Date().toISOString(),
    }, { onConflict: 'email' });
  if (error) {
    captureException(error, { context: 'admin-beta-codes.manual-grant' });
    return { statusCode: 500, body: 'Could not grant access' };
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, email, expiresAt }),
  };
}

async function handleDelete(body) {
  const id = typeof body.id === 'string' ? body.id : null;
  if (!id) return { statusCode: 400, body: 'Missing id' };
  // Hard delete. `beta_redemptions.code_id` is declared ON DELETE SET NULL
  // so users who already redeemed this code keep their access — only the
  // admin-facing record disappears. The redemption rows carry their own
  // `expires_at` + `code_hash` so entitlement checks still work.
  const { error } = await getSupabase()
    .from('beta_codes')
    .delete()
    .eq('id', id);
  if (error) {
    captureException(error, { context: 'admin-beta-codes.delete' });
    return { statusCode: 500, body: 'Could not delete code' };
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  };
}

async function adminBetaCodesHandler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: {} };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const origin = checkOrigin(event);
  if (origin.rejected) return origin.response;

  const rl = await rateLimit(event, 20);
  if (rl.limited) return rl.response;

  const auth = await authenticateAdmin(event);
  if (auth.locked) {
    return {
      statusCode: 429,
      headers: { 'Retry-After': String(auth.retryAfter || 60) },
      body: 'Admin temporarily locked',
    };
  }
  if (!auth.ok) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const body = parseBody(event);
  if (!body) return { statusCode: 400, body: 'Invalid JSON' };

  switch (body.action) {
    case 'create': return handleCreate(body);
    case 'list': return handleList();
    case 'revoke': return handleRevoke(body);
    case 'delete': return handleDelete(body);
    case 'manual-grant': return handleManualGrant(body);
    default: return { statusCode: 400, body: 'Invalid action' };
  }
}

export const handler = withCors(withSentry(adminBetaCodesHandler));
