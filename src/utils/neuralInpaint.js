/**
 * Neural inpainting engine for tattoo removal.
 *
 * Loads a trained U-Net ONNX model and runs inference in the browser
 * via ONNX Runtime Web. Produces dramatically better results than
 * classical PatchMatch by synthesizing realistic skin texture.
 *
 * Model input:  [1, 4, 512, 512] — RGB (0-1) + mask (0=keep, 1=inpaint)
 * Model output: [1, 3, 512, 512] — reconstructed RGB (0-1)
 */

import * as ort from 'onnxruntime-web';

const MODEL_PATH = '/models/skin-inpaint.onnx';
const MODEL_SIZE = 512; // Model's native resolution

let session = null;
let loadingPromise = null;
let modelAvailable = null; // null = unknown, true/false = checked

/**
 * Check if the neural inpainting model is available.
 */
export async function isNeuralInpaintAvailable() {
  if (modelAvailable !== null) return modelAvailable;

  try {
    const resp = await fetch(MODEL_PATH, { method: 'HEAD' });
    modelAvailable = resp.ok;
  } catch {
    modelAvailable = false;
  }

  console.log(`[NeuralInpaint] Model ${modelAvailable ? 'available' : 'not found'} at ${MODEL_PATH}`);
  return modelAvailable;
}

/**
 * Load the ONNX inpainting model. Returns the session or null if unavailable.
 */
export async function loadInpaintModel() {
  if (session) return session;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      const available = await isNeuralInpaintAvailable();
      if (!available) return null;

      console.log('[NeuralInpaint] Loading model...');
      const t0 = performance.now();

      session = await ort.InferenceSession.create(MODEL_PATH, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });

      console.log(`[NeuralInpaint] Model loaded in ${(performance.now() - t0).toFixed(0)}ms`);
      console.log(`[NeuralInpaint] Inputs: ${session.inputNames}, Outputs: ${session.outputNames}`);
      return session;
    } catch (err) {
      console.warn('[NeuralInpaint] Failed to load model:', err);
      modelAvailable = false;
      session = null;
      return null;
    } finally {
      loadingPromise = null;
    }
  })();

  return loadingPromise;
}

/**
 * Run neural inpainting on a region.
 *
 * @param {Uint8Array} pixels - RGBA pixel data of the region
 * @param {Uint8Array} mask - Binary mask (1 = inpaint, 0 = keep)
 * @param {number} width - Region width
 * @param {number} height - Region height
 * @returns {Uint8Array} - Inpainted RGBA pixel data (same size as input)
 */
export async function neuralInpaint(pixels, mask, width, height) {
  const sess = await loadInpaintModel();
  if (!sess) {
    throw new Error('Neural inpaint model not available');
  }

  console.log(`[NeuralInpaint] Inpainting ${width}x${height} region...`);
  const t0 = performance.now();

  // Step 1: Resize input to model size (512x512)
  const inputRGB = resizeRGBA(pixels, width, height, MODEL_SIZE, MODEL_SIZE);
  const inputMask = resizeMask(mask, width, height, MODEL_SIZE, MODEL_SIZE);

  // Step 2: Build input tensor [1, 4, 512, 512]
  // Channels: R, G, B (normalized 0-1, masked areas filled with 0.5), Mask (0 or 1)
  const inputData = new Float32Array(4 * MODEL_SIZE * MODEL_SIZE);
  const planeSize = MODEL_SIZE * MODEL_SIZE;

  for (let i = 0; i < planeSize; i++) {
    const pi = i * 4; // RGBA index in resized buffer
    const m = inputMask[i] ? 1.0 : 0.0;

    // RGB channels: gray-fill in masked regions
    inputData[0 * planeSize + i] = m > 0.5 ? 0.5 : inputRGB[pi] / 255;       // R
    inputData[1 * planeSize + i] = m > 0.5 ? 0.5 : inputRGB[pi + 1] / 255;   // G
    inputData[2 * planeSize + i] = m > 0.5 ? 0.5 : inputRGB[pi + 2] / 255;   // B
    inputData[3 * planeSize + i] = m;                                           // Mask
  }

  // Step 3: Run inference
  const inputTensor = new ort.Tensor('float32', inputData, [1, 4, MODEL_SIZE, MODEL_SIZE]);
  const results = await sess.run({ [sess.inputNames[0]]: inputTensor });
  const outputData = results[sess.outputNames[0]].data;

  // Step 4: Extract output RGB at model resolution
  const outputRGBA = new Uint8Array(MODEL_SIZE * MODEL_SIZE * 4);
  for (let i = 0; i < planeSize; i++) {
    const pi = i * 4;
    outputRGBA[pi] = Math.round(Math.max(0, Math.min(1, outputData[0 * planeSize + i])) * 255);
    outputRGBA[pi + 1] = Math.round(Math.max(0, Math.min(1, outputData[1 * planeSize + i])) * 255);
    outputRGBA[pi + 2] = Math.round(Math.max(0, Math.min(1, outputData[2 * planeSize + i])) * 255);
    outputRGBA[pi + 3] = 255;
  }

  // Step 5: Resize back to original dimensions
  const result = resizeRGBA(outputRGBA, MODEL_SIZE, MODEL_SIZE, width, height);

  // Step 6: Only replace masked pixels (keep originals in unmasked areas)
  const output = new Uint8Array(pixels.length);
  for (let i = 0; i < width * height; i++) {
    const pi = i * 4;
    if (mask[i]) {
      output[pi] = result[pi];
      output[pi + 1] = result[pi + 1];
      output[pi + 2] = result[pi + 2];
      output[pi + 3] = pixels[pi + 3];
    } else {
      output[pi] = pixels[pi];
      output[pi + 1] = pixels[pi + 1];
      output[pi + 2] = pixels[pi + 2];
      output[pi + 3] = pixels[pi + 3];
    }
  }

  console.log(`[NeuralInpaint] Done in ${(performance.now() - t0).toFixed(0)}ms`);
  return output;
}

/**
 * Bilinear resize of RGBA pixel buffer.
 */
function resizeRGBA(src, srcW, srcH, dstW, dstH) {
  const dst = new Uint8Array(dstW * dstH * 4);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const srcX = x * xRatio;
      const srcY = y * yRatio;
      const x0 = Math.floor(srcX);
      const y0 = Math.floor(srcY);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const y1 = Math.min(y0 + 1, srcH - 1);
      const tx = srcX - x0;
      const ty = srcY - y0;

      const di = (y * dstW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const v00 = src[(y0 * srcW + x0) * 4 + c];
        const v10 = src[(y0 * srcW + x1) * 4 + c];
        const v01 = src[(y1 * srcW + x0) * 4 + c];
        const v11 = src[(y1 * srcW + x1) * 4 + c];
        dst[di + c] = Math.round(
          v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) +
          v01 * (1 - tx) * ty + v11 * tx * ty
        );
      }
    }
  }

  return dst;
}

/**
 * Nearest-neighbor resize of binary mask.
 */
function resizeMask(src, srcW, srcH, dstW, dstH) {
  const dst = new Uint8Array(dstW * dstH);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(Math.floor(x * xRatio), srcW - 1);
      const sy = Math.min(Math.floor(y * yRatio), srcH - 1);
      dst[y * dstW + x] = src[sy * srcW + sx];
    }
  }

  return dst;
}
