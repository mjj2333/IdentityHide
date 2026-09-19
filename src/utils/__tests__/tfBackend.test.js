import { describe, it, expect, vi } from 'vitest';
import { selectBackend } from '../tfBackend';

// Minimal stand-in for the tfjs-core namespace: setBackend resolves true/false
// (real TF.js resolves false — it does not throw — when a backend can't
// initialise), ready resolves once the backend is usable.
function fakeTf(working) {
  const calls = [];
  return {
    calls,
    setBackend: vi.fn(async (name) => { calls.push(`set:${name}`); return working.includes(name); }),
    ready: vi.fn(async () => { calls.push('ready'); }),
  };
}

const candidate = (name, load = async () => {}) => ({ name, load: vi.fn(load) });

describe('selectBackend', () => {
  it('uses the first candidate when it initialises', async () => {
    const tf = fakeTf(['wasm', 'webgl', 'cpu']);
    const name = await selectBackend(tf, [candidate('wasm'), candidate('webgl')]);
    expect(name).toBe('wasm');
    expect(tf.calls).toEqual(['set:wasm', 'ready']);
  });

  it('loads a backend module before asking TF.js to use it', async () => {
    const tf = fakeTf(['wasm']);
    const order = [];
    const wasm = candidate('wasm', async () => { order.push('load'); });
    tf.setBackend.mockImplementationOnce(async () => { order.push('set'); return true; });
    await selectBackend(tf, [wasm]);
    expect(order).toEqual(['load', 'set']);
  });

  it('never downloads fallback backends when the preferred one works', async () => {
    const tf = fakeTf(['wasm', 'webgl']);
    const webgl = candidate('webgl');
    await selectBackend(tf, [candidate('wasm'), webgl]);
    expect(webgl.load).not.toHaveBeenCalled();
  });

  it('falls through when setBackend resolves false', async () => {
    const tf = fakeTf(['webgl']);
    expect(await selectBackend(tf, [candidate('wasm'), candidate('webgl')])).toBe('webgl');
  });

  it('falls through when the backend module fails to load', async () => {
    const tf = fakeTf(['wasm', 'cpu']);
    const broken = candidate('wasm', async () => { throw new Error('chunk 404'); });
    expect(await selectBackend(tf, [broken, candidate('cpu')])).toBe('cpu');
    expect(tf.setBackend).not.toHaveBeenCalledWith('wasm');
  });

  it('falls through when setBackend throws', async () => {
    const tf = fakeTf(['cpu']);
    tf.setBackend.mockImplementationOnce(async () => { throw new Error('boom'); });
    expect(await selectBackend(tf, [candidate('wasm'), candidate('cpu')])).toBe('cpu');
  });

  it('rejects when no backend can be initialised', async () => {
    const tf = fakeTf([]);
    await expect(selectBackend(tf, [candidate('wasm'), candidate('cpu')]))
      .rejects.toThrow(/no tensorflow\.js backend/i);
  });
});
