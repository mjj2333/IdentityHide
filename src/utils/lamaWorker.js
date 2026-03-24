/**
 * Web Worker for LaMa ONNX inference.
 * Runs in a separate thread with its own WASM executable memory budget,
 * avoiding Firefox's per-context limit on JIT-compiled WASM code.
 */
import * as ort from 'onnxruntime-web';

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

const MODEL_PATH = '/models/lama_fp32.onnx';
const LAMA_SIZE = 512;
const CH = LAMA_SIZE * LAMA_SIZE;

let session = null;

async function init() {
  if (session) return;
  console.log('[LaMa Worker] Loading model…');
  const t0 = performance.now();
  session = await ort.InferenceSession.create(MODEL_PATH, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  console.log(`[LaMa Worker] Loaded in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

async function inpaint(imageFloat32, maskFloat32) {
  if (!session) throw new Error('Model not loaded');

  const imageTensor = new ort.Tensor('float32', imageFloat32, [1, 3, LAMA_SIZE, LAMA_SIZE]);
  const maskTensor = new ort.Tensor('float32', maskFloat32, [1, 1, LAMA_SIZE, LAMA_SIZE]);

  const t0 = performance.now();
  const results = await session.run({
    [session.inputNames[0]]: imageTensor,
    [session.inputNames[1]]: maskTensor,
  });
  console.log(`[LaMa Worker] Inference ${(performance.now() - t0).toFixed(0)}ms`);

  const output = results[session.outputNames[0]];

  // Convert CHW output to HWC RGBA Uint8Array for the main thread
  const rgba = new Uint8Array(CH * 4);
  const d = output.data;
  for (let i = 0; i < CH; i++) {
    rgba[i * 4]     = d[i];
    rgba[i * 4 + 1] = d[CH + i];
    rgba[i * 4 + 2] = d[2 * CH + i];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

self.onmessage = async (e) => {
  const { type, id } = e.data;
  try {
    if (type === 'init') {
      await init();
      self.postMessage({ type: 'init', id, ok: true });
    } else if (type === 'inpaint') {
      const { imageData, maskData } = e.data;
      const rgba = await inpaint(imageData, maskData);
      self.postMessage(
        { type: 'inpaint', id, rgba: rgba.buffer },
        [rgba.buffer] // transfer ownership for zero-copy
      );
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err.message });
  }
};
