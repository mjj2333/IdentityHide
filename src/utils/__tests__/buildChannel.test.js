import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const native = vi.hoisted(() => ({ platform: 'ios', get: vi.fn() }));
vi.mock('../platform', () => ({ getNativePlatform: () => native.platform }));
vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({ get: native.get }) }));

import { isAdFreeBuild, _resetForTests } from '../buildChannel';

beforeEach(() => {
  _resetForTests();
  native.platform = 'ios';
  native.get.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('isAdFreeBuild', () => {
  it('is true in an iOS TestFlight build', async () => {
    native.get.mockResolvedValue({ channel: 'testflight' });
    expect(await isAdFreeBuild()).toBe(true);
  });

  it('is false in the App Store build', async () => {
    native.get.mockResolvedValue({ channel: 'appstore' });
    expect(await isAdFreeBuild()).toBe(false);
  });

  it('is false on Android and the web without asking the native side', async () => {
    for (const p of ['android', null]) {
      _resetForTests();
      native.platform = p;
      expect(await isAdFreeBuild()).toBe(false);
    }
    expect(native.get).not.toHaveBeenCalled();
  });

  it('keeps ads on when the native side is missing (an older app binary)', async () => {
    native.get.mockRejectedValue(new Error('"BuildChannel" plugin is not implemented on ios'));
    expect(await isAdFreeBuild()).toBe(false);
  });

  it('keeps ads on when the native side never answers', async () => {
    vi.useFakeTimers();
    native.get.mockReturnValue(new Promise(() => {}));
    const result = isAdFreeBuild();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBe(false);
  });

  it('asks the native side only once per launch', async () => {
    native.get.mockResolvedValue({ channel: 'testflight' });
    await isAdFreeBuild();
    await isAdFreeBuild();
    expect(native.get).toHaveBeenCalledTimes(1);
  });
});
