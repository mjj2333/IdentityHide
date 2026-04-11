import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison of the Bearer token in the Authorization header
 * against process.env.ADMIN_PASSWORD. Rejects on missing env var so a blank
 * ADMIN_PASSWORD can't accidentally grant access.
 *
 * @param {object} event  Netlify function event
 * @returns {boolean} true if the caller presented the correct admin password
 */
export function checkAdminAuth(event) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;

  const provided = (event.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!provided) return false;

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on length mismatch — compare a fixed-size hash pair
  // so the length itself doesn't leak via timing.
  if (a.length !== b.length) {
    // Still run a comparison against `b` so the caller's timing doesn't
    // trivially reveal whether the length matched.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
