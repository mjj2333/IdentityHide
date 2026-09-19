import { describe, it, expect, vi } from 'vitest';
import { createRetryableLoader } from '../retryableLoader';

describe('createRetryableLoader', () => {
  it('shares one in-flight load between concurrent callers', async () => {
    const loadFn = vi.fn(async () => 'model');
    const loader = createRetryableLoader(loadFn);
    const [a, b] = await Promise.all([loader.load(), loader.load()]);
    expect(a).toBe('model');
    expect(b).toBe('model');
    expect(loadFn).toHaveBeenCalledTimes(1);
  });

  it('reuses the loaded value afterwards', async () => {
    const loadFn = vi.fn(async () => 'model');
    const loader = createRetryableLoader(loadFn);
    await loader.load();
    await loader.load();
    expect(loadFn).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure — the next call tries again', async () => {
    const loadFn = vi.fn()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce('model');
    const loader = createRetryableLoader(loadFn);
    await expect(loader.load()).rejects.toThrow('Failed to fetch');
    await expect(loader.load()).resolves.toBe('model');
    expect(loadFn).toHaveBeenCalledTimes(2);
  });

  it('reports the failure to every caller that was waiting on it', async () => {
    const loader = createRetryableLoader(async () => { throw new Error('offline'); });
    const results = await Promise.allSettled([loader.load(), loader.load()]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  });

  it('reset forces a fresh load', async () => {
    const loadFn = vi.fn(async () => 'model');
    const loader = createRetryableLoader(loadFn);
    await loader.load();
    loader.reset();
    await loader.load();
    expect(loadFn).toHaveBeenCalledTimes(2);
  });

  it('a reset during a load does not let that stale load repopulate the cache', async () => {
    let finishFirst;
    const loadFn = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = () => resolve('stale'); }))
      .mockResolvedValueOnce('fresh');
    const loader = createRetryableLoader(loadFn);
    const first = loader.load();
    loader.reset();
    const second = loader.load();
    finishFirst();
    expect(await first).toBe('stale');
    expect(await second).toBe('fresh');
    expect(await loader.load()).toBe('fresh');
  });
});
