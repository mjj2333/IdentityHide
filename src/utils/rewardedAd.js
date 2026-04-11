/**
 * Rewarded video ad integration via AppLixir (v6 SDK).
 *
 * To disable:  set REWARDED_ADS_ENABLED = false (everything no-ops).
 * To remove:   delete this file and remove the 3-line gate in
 *              MaskEditorScreen.jsx handleApply().
 *
 * Current config uses test mode. After AppLixir approval, swap
 * to your production zone.
 */

// ── Feature flag ──────────────────────────────────────────────
export const REWARDED_ADS_ENABLED = false;

// ── AppLixir credentials ─────────────────────────────────────
const CONFIG = {
  apiKey: '9b7e2cd9-daf6-46c0-a61a-d3c9f12fdaa5',
  injectionElementId: 'applixir-ad',
};

// Safety timeout (ms) — if the SDK stalls, let the user through.
const AD_TIMEOUT = 45_000;

/**
 * Show a rewarded video ad before tattoo removal.
 *
 * Returns a Promise that ALWAYS resolves (never rejects):
 * - Ad completed → resolves
 * - Ad skipped / errored / timed out → resolves (user proceeds)
 * - Ads disabled or SDK not loaded → resolves immediately
 */
export function showRewardedAd() {
  if (!REWARDED_ADS_ENABLED) return Promise.resolve();

  if (typeof window.initializeAndOpenPlayer !== 'function') {
    console.warn('[rewardedAd] AppLixir SDK not loaded — skipping');
    return Promise.resolve();
  }

  console.log('[rewardedAd] Showing rewarded ad...');

  return new Promise((resolve) => {
    let settled = false;
    const done = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.log('[rewardedAd] Done:', reason);
      resolve();
    };

    const timer = setTimeout(() => {
      console.warn('[rewardedAd] Timed out after', AD_TIMEOUT, 'ms');
      done('timeout');
    }, AD_TIMEOUT);

    try {
      window.initializeAndOpenPlayer({
        apiKey: CONFIG.apiKey,
        injectionElementId: CONFIG.injectionElementId,
        adStatusCallbackFn: (status) => {
          console.log('[rewardedAd] Status:', status?.type || status);
          const type = status?.type || status;
          // Terminal statuses — resolve and let user proceed
          const terminal = [
            'complete',              // ad finished playing
            'allAdsCompleted',       // all ads done
            'skipped',               // user skipped
            'manuallyEnded',         // user closed
            'thankYouModalClosed',   // thank-you dismissed
            'consentDeclined',       // GDPR consent declined
          ];
          if (terminal.includes(type)) {
            done('status:' + type);
          }
        },
        adErrorCallbackFn: (error) => {
          const msg = error?.getError?.()?.data?.type || 'unknown';
          console.warn('[rewardedAd] Error:', msg);
          done('error:' + msg);
        },
      });
    } catch (err) {
      console.warn('[rewardedAd] SDK error:', err?.message || err);
      done('error');
    }
  });
}
