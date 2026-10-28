/**
 * AdMob (native) rewarded-video integration via @capacitor-community/admob.
 *
 * Web builds NEVER reach this: showRewardedAd() in rewardedAd.js branches on
 * isNativeApp() and only calls in the native shell, and the plugin is
 * dynamically imported here so it stays out of the web bundle entirely.
 *
 * iOS uses the real AdMob IDs. Android still uses Google's official TEST ad
 * unit IDs, which always serve test ads. Before shipping real Android ads, swap:
 *   1. REWARDED_AD_IDS below (per platform), and
 *   2. the AdMob app-id meta-data in the native projects
 *      (android/app/src/main/AndroidManifest.xml APPLICATION_ID, and the iOS
 *      Info.plist GADApplicationIdentifier)
 * for your real AdMob unit + app IDs.
 */
import { getNativePlatform } from './platform';

// Rewarded ad units, one per platform. iOS is the real unit; Android is still
// Google's official TEST unit. getNativePlatform() selects at show time and
// falls back to Android if the platform is unknown.
const REWARDED_AD_IDS = {
  android: 'ca-app-pub-3940256099942544/5224354917',
  ios: 'ca-app-pub-5282264563005092/8560497350',
};

// Safety ceilings. Loading gets 45 s; if no ad appears by then the user is let
// through with completed:false. Once an ad is on screen there is no short
// limit: rewarded ads often run past 45 s (a 30 s video, an end card, or two
// ads back to back), and giving up mid-ad threw the reward away and sent the
// user round the "watch an ad" prompt again and again. The long ceiling only
// covers an ad that never reports being closed.
const LOAD_TIMEOUT = 45_000;
const SHOWING_TIMEOUT = 5 * 60_000;
// A reward reported a moment after the close still counts.
const REWARD_GRACE = 500;

let initialized = false;

/**
 * Initialize AdMob and run the UMP consent flow once. Safe to call on every
 * native app start (no-ops after the first success). Never throws.
 */
export async function initAdMob() {
  if (initialized) return;
  try {
    const { AdMob, AdmobConsentStatus } = await import('@capacitor-community/admob');
    // iOS App Tracking Transparency: Apple requires the ATT prompt before any
    // IDFA use. Gated to iOS so Android's path is unchanged (Android doesn't
    // use ATT). NOTE: requires NSUserTrackingUsageDescription in the iOS
    // Info.plist (Phase 1) or iOS terminates the app on this call. Best-effort:
    // a failure here must not block init or ad serving.
    if (getNativePlatform() === 'ios') {
      try {
        const { status } = await AdMob.trackingAuthorizationStatus();
        if (status === 'notDetermined') {
          await AdMob.requestTrackingAuthorization();
        }
      } catch (e) {
        console.warn('[admob] ATT prompt skipped:', e?.message || e);
      }
    }
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
    let timer = null;
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
      resolve({ completed: earned, reason: earned ? 'rewarded' : reason });
    };
    const limit = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => done('timeout'), ms);
    };
    limit(LOAD_TIMEOUT);

    (async () => {
      try {
        listeners.push(await AdMob.addListener(RewardAdPluginEvents.Rewarded, () => { earned = true; }));
        listeners.push(await AdMob.addListener(RewardAdPluginEvents.Showed, () => limit(SHOWING_TIMEOUT)));
        // Dismissed fires whether or not the reward was earned; it's the
        // terminal signal (user closed the ad). Wait a beat for a reward
        // that is reported just after it.
        listeners.push(await AdMob.addListener(RewardAdPluginEvents.Dismissed, () => {
          if (earned) done('rewarded');
          else setTimeout(() => done('dismissed'), REWARD_GRACE);
        }));
        listeners.push(await AdMob.addListener(RewardAdPluginEvents.FailedToShow, () => done('error:show')));
        listeners.push(await AdMob.addListener(RewardAdPluginEvents.FailedToLoad, () => done('error:load')));
        const adId = REWARDED_AD_IDS[getNativePlatform()] || REWARDED_AD_IDS.android;
        await AdMob.prepareRewardVideoAd({ adId });
        // The show call itself resolves with the reward once it is earned
        // (and never resolves otherwise), on both iOS and Android.
        const reward = await AdMob.showRewardVideoAd();
        if (reward) earned = true;
      } catch (err) {
        done('error:' + (err?.message || 'unknown'));
      }
    })();
  });
}
