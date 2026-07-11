/**
 * AdMob (native) rewarded-video integration via @capacitor-community/admob.
 *
 * Web builds NEVER reach this: showRewardedAd() in rewardedAd.js branches on
 * isNativeApp() and only calls in the native shell, and the plugin is
 * dynamically imported here so it stays out of the web bundle entirely.
 *
 * SCAFFOLD STATE: uses Google's official TEST ad unit ID, which always serves
 * test ads with zero policy risk. Before shipping real ads, swap:
 *   1. REWARDED_AD_ID below, and
 *   2. the APPLICATION_ID meta-data in
 *      android/app/src/main/AndroidManifest.xml
 * for your real AdMob unit + app IDs. Android only for now (iOS adds ATT).
 */

// Google's official Android TEST rewarded ad unit (safe placeholder).
const REWARDED_AD_ID = 'ca-app-pub-3940256099942544/5224354917';

// Reward-video safety ceiling: if prepare/show stalls, let the user through
// with completed:false, matching the AppLixir path's behaviour.
const AD_TIMEOUT = 45_000;

let initialized = false;

/**
 * Initialize AdMob and run the UMP consent flow once. Safe to call on every
 * native app start (no-ops after the first success). Never throws.
 */
export async function initAdMob() {
  if (initialized) return;
  try {
    const { AdMob, AdmobConsentStatus } = await import('@capacitor-community/admob');
    await AdMob.initialize();
    try {
      const info = await AdMob.requestConsentInfo();
      if (info?.isConsentFormAvailable && info.status === AdmobConsentStatus.REQUIRED) {
        await AdMob.showConsentForm();
      }
    } catch (e) {
      // Consent is best-effort; a failure here must not block ad serving.
      console.warn('[admob] consent flow skipped:', e?.message || e);
    }
    initialized = true;
  } catch (e) {
    console.warn('[admob] init failed:', e?.message || e);
  }
}

/**
 * Show a rewarded video. ALWAYS resolves (never rejects) with
 *   { completed: boolean, reason: string }
 * mirroring the AppLixir showRewardedAd() contract so callers are identical.
 * completed:true only when the Rewarded event fired (user actually earned it).
 */
export async function showAdMobRewarded() {
  let AdMob, RewardAdPluginEvents;
  try {
    ({ AdMob, RewardAdPluginEvents } = await import('@capacitor-community/admob'));
  } catch {
    return { completed: false, reason: 'no-sdk' };
  }
  if (!initialized) await initAdMob();

  return new Promise((resolve) => {
    let earned = false;
    let settled = false;
    const listeners = [];
    const cleanup = async () => {
      for (const l of listeners) { try { await l.remove(); } catch { /* ignore */ } }
    };
    const done = async (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await cleanup();
      console.log('[admob] rewarded done:', reason, { earned });
      resolve({ completed: earned, reason });
    };
    const timer = setTimeout(() => done('timeout'), AD_TIMEOUT);

    (async () => {
      try {
        listeners.push(await AdMob.addListener(RewardAdPluginEvents.Rewarded, () => { earned = true; }));
        // Dismissed fires whether or not the reward was earned; it's the
        // terminal signal (user closed the ad), so resolve on it.
        listeners.push(await AdMob.addListener(RewardAdPluginEvents.Dismissed, () => done(earned ? 'rewarded' : 'dismissed')));
        listeners.push(await AdMob.addListener(RewardAdPluginEvents.FailedToShow, () => done('error:show')));
        listeners.push(await AdMob.addListener(RewardAdPluginEvents.FailedToLoad, () => done('error:load')));
        await AdMob.prepareRewardVideoAd({ adId: REWARDED_AD_ID });
        await AdMob.showRewardVideoAd();
      } catch (err) {
        done('error:' + (err?.message || 'unknown'));
      }
    })();
  });
}
