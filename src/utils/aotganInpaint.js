/**
 * AOT-GAN inpainting via ONNX Runtime WebGL backend.
 *
 * Lightweight (58MB) inpainting model that uses only standard ops
 * (Conv, Relu, Pad, etc.) — works on WebGL with zero WASM.
 * Compatible with all browsers including older iOS Safari.
 */
import * as ort from 'onnxruntime-web/webgl';

const MODEL_PATH = '/models/aotgan_fp32.onnx';
const SIZE = 512;

let session = null;
let initPromise = null;

export async function initAOTGAN() {
  if (session) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      console.log('[AOT-GAN] Loading model (WebGL)…');
      const t0 = performance.now();
      session = await ort.InferenceSession.create(MODEL_PATH, {
        executionProviders: ['webgl'],
      });
      console.log(`[AOT-GAN] Loaded in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      return true;
    } catch (err) {
      console.warn('[AOT-GAN] Failed to load:', err.message);
      initPromise = null;
      session = null;
      return false;
    }
  })();

  return initPromise;
}

/**
 * Dilate a binary mask by `radius` pixels (circular kernel).
 */
function dilateMask(mask, w, h, radius) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) { out[y * w + x] = 1; continue; }
      let found = false;
      const y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
      const x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
      for (let ny = y0; ny <= y1 && !found; ny++) {
        for (let nx = x0; nx <= x1 && !found; nx++) {
          if (mask[ny * w + nx]) {
            const dx = nx - x, dy = ny - y;
            if (dx * dx + dy * dy <= radius * radius) found = true;
          }
        }
      }
      if (found) out[y * w + x] = 1;
    }
  }
  return out;
}

/**
 * Inpaint a region using AOT-GAN.
 *
 * @param {Uint8Array} regionPixels – RGBA pixels (rw × rh × 4)
 * @param {Uint8Array} regionMask  – Binary mask 0/1 (rw × rh)
 * @param {number} rw – Region width
 * @param {number} rh – Region height
 * @returns {Uint8Array} – Inpainted RGBA pixels (rw × rh × 4)
 */
export async function aotganInpaintRegion(regionPixels, regionMask, rw, rh) {
  if (!session) {
    const ok = await initAOTGAN();
    if (!ok) throw new Error('AOT-GAN model not available');
  }

  // Dilate mask to cover ink edges
  const dilateR = Math.max(4, Math.round(Math.max(rw, rh) / 60));
  const dilatedMask = dilateMask(regionMask, rw, rh, dilateR);
  console.log(`[AOT-GAN] Dilated mask by ${dilateR}px`);

  // --- Resize region to 512×512 (bilinear) ---
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = rw;
  srcCanvas.height = rh;
  const srcCtx = srcCanvas.getContext('2d');
  const srcImgData = srcCtx.createImageData(rw, rh);
  srcImgData.data.set(regionPixels);
  srcCtx.putImageData(srcImgData, 0, 0);

  const resized = document.createElement('canvas');
  resized.width = SIZE;
  resized.height = SIZE;
  resized.getContext('2d').drawImage(srcCanvas, 0, 0, SIZE, SIZE);

  // --- Resize dilated mask to 512×512 (nearest-neighbor) ---
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = rw;
  maskCanvas.height = rh;
  const maskCtx = maskCanvas.getContext('2d');
  const maskImgData = maskCtx.createImageData(rw, rh);
  for (let i = 0; i < rw * rh; i++) {
    const v = dilatedMask[i] ? 255 : 0;
    maskImgData.data[i * 4] = v;
    maskImgData.data[i * 4 + 1] = v;
    maskImgData.data[i * 4 + 2] = v;
    maskImgData.data[i * 4 + 3] = 255;
  }
  maskCtx.putImageData(maskImgData, 0, 0);

  const resizedMask = document.createElement('canvas');
  resizedMask.width = SIZE;
  resizedMask.height = SIZE;
  const rmCtx = resizedMask.getContext('2d');
  rmCtx.imageSmoothingEnabled = false;
  rmCtx.drawImage(maskCanvas, 0, 0, SIZE, SIZE);

  // --- Pack image tensor [1, 3, 512, 512] float32 (0–1) ---
  const imgPixels = resized.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;
  const ch = SIZE * SIZE;
  const imageFloat = new Float32Array(3 * ch);
  for (let i = 0; i < ch; i++) {
    const pi = i * 4;
    imageFloat[i] = imgPixels[pi] / 255;
    imageFloat[ch + i] = imgPixels[pi + 1] / 255;
    imageFloat[2 * ch + i] = imgPixels[pi + 2] / 255;
  }

  // --- Pack mask tensor [1, 1, 512, 512] float32 (0 or 1) ---
  const maskPixels = rmCtx.getImageData(0, 0, SIZE, SIZE).data;
  const maskFloat = new Float32Array(ch);
  for (let i = 0; i < ch; i++) {
    maskFloat[i] = maskPixels[i * 4] > 128 ? 1.0 : 0.0;
  }

  // --- Inference ---
  const imageTensor = new ort.Tensor('float32', imageFloat, [1, 3, SIZE, SIZE]);
  const maskTensor = new ort.Tensor('float32', maskFloat, [1, 1, SIZE, SIZE]);

  const t0 = performance.now();
  const results = await session.run({ image: imageTensor, mask: maskTensor });
  console.log(`[AOT-GAN] Inference ${(performance.now() - t0).toFixed(0)}ms`);

  // --- Decode output [1, 3, 512, 512] float32 [0,1] ---
  const outData = results.painted_image.data;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = SIZE;
  outCanvas.height = SIZE;
  const outCtx = outCanvas.getContext('2d');
  const outImgData = outCtx.createImageData(SIZE, SIZE);

  for (let i = 0; i < ch; i++) {
    const di = i * 4;
    outImgData.data[di]     = Math.round(Math.min(1, Math.max(0, outData[i]))         * 255);
    outImgData.data[di + 1] = Math.round(Math.min(1, Math.max(0, outData[ch + i]))     * 255);
    outImgData.data[di + 2] = Math.round(Math.min(1, Math.max(0, outData[2 * ch + i])) * 255);
    outImgData.data[di + 3] = 255;
  }
  outCtx.putImageData(outImgData, 0, 0);

  // --- Resize back to original region ---
  const finalCanvas = document.createElement('canvas');
  finalCanvas.width = rw;
  finalCanvas.height = rh;
  finalCanvas.getContext('2d').drawImage(outCanvas, 0, 0, rw, rh);

  return new Uint8Array(finalCanvas.getContext('2d').getImageData(0, 0, rw, rh).data.buffer);
}
