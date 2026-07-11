/**
 * Rewarded video ad integration.
 *
 * Platform split: NATIVE (Capacitor) uses AdMob (see admobAds.js); WEB/PWA
 * uses AppLixir (below). Both return the identical
 *   { completed: boolean, reason: string }
 * contract, so callers (PaywallModal, BatchGridScreen) don't branch.
 *
 * To disable:  set REWARDED_ADS_ENABLED = false (everything no-ops).
 * To remove:   delete this file and remove the 3-line gate in
 *              MaskEditorScreen.jsx handleApply().
 *
 * AppLixir config uses test mode. After AppLixir approval, swap to the
 * production zone.
 */

import { isNativeApp } from './platform';

// ── Feature flag ──────────────────────────────────────────────
export const REWARDED_ADS_ENABLED = true;

// Terminal SDK statuses that count as "the user actually watched the ad".
// Used to gate rewarded-credit grants — skipping / closing / consent decline
// should NOT earn a credit. Keep in sync with AppLixir's status vocabulary.
const COMPLETED_STATUSES = new Set(['complete', 'allAdsCompleted']);

// ── AppLixir credentials ─────────────────────────────────────
const CONFIG = {
  apiKey: '9b7e2cd9-daf6-46c0-a61a-d3c9f12fdaa5',
  injectionElementId: 'applixir-ad',
};

// Safety timeout (ms) — if the SDK stalls, let the user through.
const AD_TIMEOUT = 45_000;

/**
 * Show a rewarded video ad.
 *
 * Returns a Promise that ALWAYS resolves (never rejects) with
 *   { completed: boolean, reason: string }
 *
 * `completed: true` means the user actually watched the ad to the end —
 * only those cases should grant a reward. Skips, closes, timeouts, errors,
 * and consent declines all resolve with `completed: false`.
 *
 * When ads are disabled or the SDK isn't loaded, resolves immediately with
 * `{ completed: false, reason: 'disabled' | 'no-sdk' }`.
 */
export function showRewardedAd() {
  if (!REWARDED_ADS_ENABLED) {
    return Promise.resolve({ completed: false, reason: 'disabled' });
  }

  // Native shells serve AdMob rewarded video instead of AppLixir. The module
  // (and the AdMob plugin) is dynamically imported so it never enters the web
  // bundle, and returns the same { completed, reason } shape.
  if (isNativeApp()) {
    return import('./admobAds')
      .then((m) => m.showAdMobRewarded())
      .catch(() => ({ completed: false, reason: 'no-sdk' }));
  }

  if (typeof window.initializeAndOpenPlayer !== 'function') {
    console.warn('[rewardedAd] AppLixir SDK not loaded — skipping');
    return Promise.resolve({ completed: false, reason: 'no-sdk' });
  }

  console.log('[rewardedAd] Showing rewarded ad...');

  return new Promise((resolve) => {
    let settled = false;
    const done = (reason, completed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.log('[rewardedAd] Done:', reason, { completed });
      resolve({ completed, reason });
    };

    const timer = setTimeout(() => {
      console.warn('[rewardedAd] Timed out after', AD_TIMEOUT, 'ms');
      done('timeout', false);
    }, AD_TIMEOUT);

    try {
      window.initializeAndOpenPlayer({
        apiKey: CONFIG.apiKey,
        injectionElementId: CONFIG.injectionElementId,
        adStatusCallbackFn: (status) => {
          console.log('[rewardedAd] Status:', status?.type || status);
          const type = status?.type || status;
          const terminal = [
            'complete', 'allAdsCompleted',
            'skipped', 'manuallyEnded', 'thankYouModalClosed', 'consentDeclined',
          ];
          if (terminal.includes(type)) {
            done('status:' + type, COMPLETED_STATUSES.has(type));
          }
        },
        adErrorCallbackFn: (error) => {
          const msg = error?.getError?.()?.data?.type || 'unknown';
          console.warn('[rewardedAd] Error:', msg);
          done('error:' + msg, false);
        },
      });
    } catch (err) {
      console.warn('[rewardedAd] SDK error:', err?.message || err);
      done('error', false);
    }
  });
}
