import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A fake AdMob plugin whose events the tests fire by hand, on a fake clock.
const admob = vi.hoisted(() => {
  const listeners = new Map();
  const state = { prepare: null, show: null };
  return {
    listeners,
    state,
    emit(name, data = {}) { for (const fn of listeners.get(name) || []) fn(data); },
    AdMob: {
      initialize: async () => {},
      trackingAuthorizationStatus: async () => ({ status: 'authorized' }),
      requestTrackingAuthorization: async () => {},
      requestConsentInfo: async () => ({ isConsentFormAvailable: false }),
      addListener: async (name, fn) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(fn);
        return { remove: async () => listeners.get(name).delete(fn) };
      },
      prepareRewardVideoAd: (opts) => state.prepare(opts),
      showRewardVideoAd: () => state.show(),
    },
  };
});

vi.mock('@capacitor-community/admob', () => ({
  AdMob: admob.AdMob,
  AdmobConsentStatus: { REQUIRED: 'REQUIRED' },
  RewardAdPluginEvents: {
    Loaded: 'onRewardedVideoAdLoaded',
    FailedToLoad: 'onRewardedVideoAdFailedToLoad',
    Showed: 'onRewardedVideoAdShowed',
    FailedToShow: 'onRewardedVideoAdFailedToShow',
    Dismissed: 'onRewardedVideoAdDismissed',
    Rewarded: 'onRewardedVideoAdReward',
  },
}));
vi.mock('../platform', () => ({ getNativePlatform: () => 'ios' }));

import { showAdMobRewarded } from '../admobAds';

const EV = {
  showed: 'onRewardedVideoAdShowed',
  dismissed: 'onRewardedVideoAdDismissed',
  rewarded: 'onRewardedVideoAdReward',
  failedToLoad: 'onRewardedVideoAdFailedToLoad',
};
const sec = (s) => vi.advanceTimersByTimeAsync(s * 1000);

let settled;
const start = () => {
  settled = null;
  showAdMobRewarded().then((r) => { settled = r; });
};

beforeEach(() => {
  vi.useFakeTimers();
  admob.listeners.clear();
  // Loads instantly; showing presents the ad and, like the real plugin, the
  // show call only resolves if the reward is earned (never, by default).
  admob.state.prepare = async () => ({ adUnitId: 'x' });
  admob.state.show = () => { admob.emit(EV.showed); return new Promise(() => {}); };
});
afterEach(() => { vi.useRealTimers(); });

describe('showAdMobRewarded', () => {
  it('grants the reward for a long ad that is watched to the end', async () => {
    start();
    await sec(60);
    admob.emit(EV.rewarded, { type: 'coins', amount: 1 });
    await sec(10);
    admob.emit(EV.dismissed);
    await sec(1);

    expect(settled).toEqual({ completed: true, reason: 'rewarded' });
  });

  it('does not give up while the ad is still on screen', async () => {
    start();
    await sec(120);

    expect(settled).toBeNull();
  });

  it('reports an ad closed early as not completed', async () => {
    start();
    await sec(5);
    admob.emit(EV.dismissed);
    await sec(1);

    expect(settled).toEqual({ completed: false, reason: 'dismissed' });
  });

  it('still counts a reward that arrives just after the ad closes', async () => {
    start();
    await sec(30);
    admob.emit(EV.dismissed);
    admob.emit(EV.rewarded, { type: 'coins', amount: 1 });
    await sec(1);

    expect(settled).toEqual({ completed: true, reason: 'rewarded' });
  });

  it('counts the reward when only the show call reports it', async () => {
    admob.state.show = () => { admob.emit(EV.showed); return Promise.resolve({ type: 'coins', amount: 1 }); };
    start();
    await sec(30);
    admob.emit(EV.dismissed);
    await sec(1);

    expect(settled).toEqual({ completed: true, reason: 'rewarded' });
  });

  it('gives up when the ad never loads, so the user is not stuck', async () => {
    admob.state.prepare = () => new Promise(() => {});
    start();
    await sec(44);
    expect(settled).toBeNull();
    await sec(2);

    expect(settled).toEqual({ completed: false, reason: 'timeout' });
  });

  it('eventually lets go of an ad that never reports being closed', async () => {
    start();
    await sec(10 * 60);

    expect(settled).toEqual({ completed: false, reason: 'timeout' });
  });

  it('reports a load failure', async () => {
    admob.state.prepare = async () => { admob.emit(EV.failedToLoad, { code: 3 }); throw new Error('Loading failed'); };
    start();
    await sec(1);

    expect(settled?.completed).toBe(false);
    expect(settled?.reason).toMatch(/^error/);
  });
});
