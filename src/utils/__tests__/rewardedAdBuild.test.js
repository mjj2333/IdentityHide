import { describe, it, expect, vi, beforeEach } from 'vitest';

const env = vi.hoisted(() => ({ adFree: false, show: vi.fn() }));
vi.mock('../platform', () => ({ isNativeApp: () => true }));
vi.mock('../buildChannel', () => ({ isAdFreeBuild: async () => env.adFree }));
vi.mock('../admobAds', () => ({ showAdMobRewarded: env.show }));

import { showRewardedAd } from '../rewardedAd';

beforeEach(() => {
  env.adFree = false;
  env.show.mockReset().mockResolvedValue({ completed: true, reason: 'rewarded' });
});

describe('showRewardedAd in the native app', () => {
  it('shows an AdMob ad in the App Store build', async () => {
    expect(await showRewardedAd()).toEqual({ completed: true, reason: 'rewarded' });
    expect(env.show).toHaveBeenCalledTimes(1);
  });

  it('skips the ad but still grants the reward in an ad-free (TestFlight) build', async () => {
    env.adFree = true;
    expect(await showRewardedAd()).toEqual({ completed: true, reason: 'ad-free-build' });
    expect(env.show).not.toHaveBeenCalled();
  });
});
