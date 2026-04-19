import { timingSafeEqual, createHash } from 'node:crypto';
import { getStore } from '@netlify/blobs';

/**
 * Constant-time comparison of the Bearer token in the Authorization header
 * against process.env.ADMIN_PASSWORD. Rejects on missing env var so a blank
 * ADMIN_PASSWORD can't accidentally grant access.
 *
 * Hashes both inputs first so timingSafeEqual always operates on 32-byte
 * buffers, removing the length-mismatch branch. Note this doesn't fully
 * close timing leaks on `provided.length` — createHash/Buffer.from still
 * scale with input size — but the brute-force lockout + per-IP rate limit
 * make that residual channel infeasible to exploit in practice.
 *
 * @param {object} event  Netlify function event
 * @returns {boolean} true if the caller presented the correct admin password
 */
export function checkAdminAuth(event) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;

  const provided = (event.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!provided) return false;

  const hashProvided = createHash('sha256').update(provided, 'utf8').digest();
  const hashExpected = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(hashProvided, hashExpected);
}

// Global lockout state (single admin account, so failures are tracked across
// all IPs). This complements the per-IP rate limit: a distributed brute force
// using many IPs each under the per-IP cap still gets blocked by the global
// failure counter.
const LOCKOUT_KEY = 'admin_auth';
const FAILURE_WINDOW_MS = 15 * 60_000;   // 15 minutes
const MAX_FAILURES = 10;                 // failures within window before lockout
const LOCKOUT_DURATION_MS = 30 * 60_000; // 30 minute lockout

let authStore;
function getAuthStore() {
  if (!authStore) authStore = getStore('admin-auth');
  return authStore;
}

/**
 * Check admin credentials with global brute-force lockout.
 * Use this instead of raw checkAdminAuth for endpoints that handle admin auth.
 *
 * @param {object} event  Netlify function event
 * @returns {Promise<{ ok: boolean, locked: boolean, retryAfter?: number }>}
 */
export async function authenticateAdmin(event) {
  let state;
  try {
    state = await getAuthStore().get(LOCKOUT_KEY, { type: 'json' });
  } catch (err) {
    // Blob store unavailable — fall open to per-IP rate limit + password check.
    console.error('admin-auth lockout read failed:', err);
    return { ok: checkAdminAuth(event), locked: false };
  }

  const now = Date.now();
  if (state?.lockedUntil && now < state.lockedUntil) {
    return {
      ok: false,
      locked: true,
      retryAfter: Math.ceil((state.lockedUntil - now) / 1000),
    };
  }

  const passwordOk = checkAdminAuth(event);

  try {
    if (passwordOk) {
      // Clear failure counter on success (no-op write skipped if already clean).
      if (state && (state.failures || state.lockedUntil)) {
        await getAuthStore().setJSON(LOCKOUT_KEY, { failures: 0, firstFailureAt: 0, lockedUntil: 0 });
      }
    } else {
      const next = (state && now - (state.firstFailureAt || 0) <= FAILURE_WINDOW_MS)
        ? { failures: (state.failures || 0) + 1, firstFailureAt: state.firstFailureAt || now, lockedUntil: 0 }
        : { failures: 1, firstFailureAt: now, lockedUntil: 0 };

      if (next.failures >= MAX_FAILURES) {
        next.lockedUntil = now + LOCKOUT_DURATION_MS;
        next.failures = 0;
        next.firstFailureAt = 0;
      }
      await getAuthStore().setJSON(LOCKOUT_KEY, next);
    }
  } catch (err) {
    // Failure tracking is best-effort — don't break auth if the store is down.
    console.error('admin-auth lockout write failed:', err);
  }

  return { ok: passwordOk, locked: false };
}
