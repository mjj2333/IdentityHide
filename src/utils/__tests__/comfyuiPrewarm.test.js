// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The prewarm only helps if it sends the SAME positive prompt the real job will:
// on the server a job whose prompt differs from the previous job's takes
// 80–130 s instead of ~23 s (measured 3×), and a tiny prewarm with the matching
// prompt takes most of that hit (104 s → 43 s) while the user is still painting.

describe('prewarmFluxModels', () => {
  let queued;

  beforeEach(() => {
    vi.resetModules();                                   // the "already prewarmed" latch is module state
    queued = [];
    // jsdom has no canvas backend — fake only the edges the prewarm touches.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      fillRect() {},
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
    }));
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['png'], { type: 'image/png' })));
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).includes('/upload/image')) return { ok: true, json: async () => ({ name: 'uploaded.png' }) };
      if (String(url).includes('/prompt')) { queued.push(JSON.parse(init.body).prompt); return { ok: true, json: async () => ({ prompt_id: 'p1' }) }; }
      throw new Error(`unexpected fetch: ${url}`);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('queues a 1-step job with the long-standing prompt by default', async () => {
    const { prewarmFluxModels } = await import('../comfyuiApi');
    await prewarmFluxModels();
    expect(queued).toHaveLength(1);
    expect(queued[0]['8'].inputs.text).toMatch(/^bare clean skin, natural human body/);
    expect(queued[0]['13'].inputs.steps).toBe(1);
  });

  it('sends the prompt the real job will use when the caller passes one', async () => {
    const { prewarmFluxModels } = await import('../comfyuiApi');
    await prewarmFluxModels({ positivePrompt: 'only skin' });
    expect(queued).toHaveLength(1);
    expect(queued[0]['8'].inputs.text).toBe('only skin');
    expect(queued[0]['13'].inputs.steps).toBe(1);        // still the tiny 1-step job, whatever the caller passes
  });

  it('stays a 1-step job even if the caller passes steps', async () => {
    const { prewarmFluxModels } = await import('../comfyuiApi');
    await prewarmFluxModels({ steps: 28 });
    expect(queued[0]['13'].inputs.steps).toBe(1);
  });
});
