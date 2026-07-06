/**
 * Free-tier tattoo credit bucket.
 *
 * Client-only (localStorage) — premium users bypass this entirely.
 * Refills weekly on Monday local time. Users can earn extra credits by
 * watching a rewarded ad (capped at MAX_EARNED_PER_WEEK so they can't
 * mine ads indefinitely).
 *
 * Note: "same photo re-Apply" and "aborted removals" are NOT handled here —
 * that gating lives in the caller (MaskEditorScreen), which only invokes
 * `consumeCredit()` after a successful ComfyUI queue AND when it's the first
 * consume for the current pipeline session.
 */

const STORAGE_KEY = 'ih_credits';
const WEEKLY_FREE = 3;
export const MAX_EARNED_PER_WEEK = 5;

function weekStartKey() {
  // ISO-style Monday-anchored week. Uses local time so the reset lines up
  // with the user's perceived week start.
  const d = new Date();
  const day = d.getDay(); // 0 = Sunday
  const offset = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + offset);
  monday.setHours(0, 0, 0, 0);
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
}

function read() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || null; }
  catch { return null; }
}

function write(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { /* storage unavailable — in-memory only */ }
}

/**
 * Returns the current credit state, resetting for a new week if needed.
 * Always returns a normalized object shape. Migrates old daily-bucket shapes
 * (stored by pre-weekly builds) by resetting — users lose in-flight credits
 * on the migration, which is acceptable for a usage model change.
 */
export function getCreditState() {
  const weekStart = weekStartKey();
  let state = read();
  if (!state || state.weekStart !== weekStart) {
    state = { weekStart, used: 0, earnedThisWeek: 0 };
    write(state);
  }
  return state;
}

export function canConsumeCredit() {
  const s = getCreditState();
  return s.used < WEEKLY_FREE + s.earnedThisWeek;
}

/**
 * Decrement one credit. Callers should only invoke this after a successful
 * ComfyUI queue — not on Apply click — so network errors and user-aborts
 * don't burn a credit. See MaskEditorScreen.handleApply for the gating.
 */
export function consumeCredit() {
  const s = getCreditState();
  s.used += 1;
  write(s);
  return s;
}

export function canEarnMore() {
  return getCreditState().earnedThisWeek < MAX_EARNED_PER_WEEK;
}

/**
 * Grant +1 earned credit (up to MAX_EARNED_PER_WEEK). Intended to be called
 * only after a rewarded ad actually completes — see showRewardedAd's
 * `completed` flag in rewardedAd.js.
 */
export function grantRewardedCredit() {
  const s = getCreditState();
  if (s.earnedThisWeek >= MAX_EARNED_PER_WEEK) return s;
  s.earnedThisWeek += 1;
  write(s);
  return s;
}

export function creditsRemaining() {
  const s = getCreditState();
  return Math.max(0, WEEKLY_FREE + s.earnedThisWeek - s.used);
}
