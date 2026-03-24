/**
 * Lightweight U-Net for tattoo segmentation.
 * ~200K params, depthwise separable convolutions, 256x256 input/output.
 * Trained on-device from user's image+mask pairs stored in IndexedDB.
 * Supports multiple named models (per subject).
 */
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-webgl';
import { model as tfModel, layers, loadLayersModel } from '@tensorflow/tfjs-layers';

const LEGACY_KEY = 'indexeddb://tattoo-seg-model';
const KEY_PREFIX = 'indexeddb://tattoo-seg-';
const SEG_SIZE = 256;

const modelCache = new Map();

function modelKey(name) {
  return KEY_PREFIX + name;
}

// --- Model Architecture ---

function encoderBlock(input, filters, useSeparable = true) {
  let x;
  if (useSeparable) {
    x = layers.separableConv2d({ filters, kernelSize: 3, padding: 'same', activation: 'relu' }).apply(input);
  } else {
    x = layers.conv2d({ filters, kernelSize: 3, padding: 'same', activation: 'relu' }).apply(input);
  }
  x = layers.batchNormalization().apply(x);
  x = layers.separableConv2d({ filters, kernelSize: 3, padding: 'same', activation: 'relu' }).apply(x);
  x = layers.batchNormalization().apply(x);
  return x;
}

function decoderBlock(input, skip, filters) {
  let x = layers.upSampling2d({ size: [2, 2] }).apply(input);
  x = layers.concatenate().apply([x, skip]);
  x = layers.separableConv2d({ filters, kernelSize: 3, padding: 'same', activation: 'relu' }).apply(x);
  x = layers.batchNormalization().apply(x);
  x = layers.separableConv2d({ filters, kernelSize: 3, padding: 'same', activation: 'relu' }).apply(x);
  x = layers.batchNormalization().apply(x);
  return x;
}

export function createTattooSegModel() {
  const input = layers.input({ shape: [SEG_SIZE, SEG_SIZE, 3] });

  // Encoder
  const e1 = encoderBlock(input, 16, false); // regular conv for 3-channel input
  const p1 = layers.maxPooling2d({ poolSize: 2 }).apply(e1);

  const e2 = encoderBlock(p1, 32);
  const p2 = layers.maxPooling2d({ poolSize: 2 }).apply(e2);

  const e3 = encoderBlock(p2, 64);
  const p3 = layers.maxPooling2d({ poolSize: 2 }).apply(e3);

  // Bottleneck
  let b = encoderBlock(p3, 128);
  b = layers.dropout({ rate: 0.3 }).apply(b);

  // Decoder with skip connections
  const d3 = decoderBlock(b, e3, 64);
  const d2 = decoderBlock(d3, e2, 32);
  const d1 = decoderBlock(d2, e1, 16);

  // Output
  const output = layers.conv2d({ filters: 1, kernelSize: 1, padding: 'same', activation: 'sigmoid' }).apply(d1);

  const model = tfModel({ inputs: input, outputs: output });
  return model;
}

// --- Persistence ---

export async function loadTattooSegModel(name = 'default') {
  if (modelCache.has(name)) return modelCache.get(name);

  try {
    const models = await tf.io.listModels();
    const key = modelKey(name);

    // Legacy migration: old single-model key -> 'default'
    if (name === 'default' && !(key in models) && LEGACY_KEY in models) {
      console.log('[TattooSeg] Migrating legacy model to "default"');
      const m = await loadLayersModel(LEGACY_KEY);
      await m.save(key);
      await tf.io.removeModel(LEGACY_KEY);
      modelCache.set(name, m);
      return m;
    }

    if (!(key in models)) return null;

    const m = await loadLayersModel(key);
    modelCache.set(name, m);
    console.log(`[TattooSeg] Loaded model "${name}"`);
    return m;
  } catch (err) {
    console.warn(`[TattooSeg] Failed to load model "${name}":`, err.message);
    return null;
  }
}

export async function saveTattooSegModel(model, name = 'default') {
  await model.save(modelKey(name));
  modelCache.set(name, model);
  console.log(`[TattooSeg] Model "${name}" saved`);
}

export async function isTattooSegModelTrained(name = 'default') {
  try {
    const models = await tf.io.listModels();
    // Also check legacy key for 'default'
    return modelKey(name) in models || (name === 'default' && LEGACY_KEY in models);
  } catch {
    return false;
  }
}

export function disposeTattooSegModel(name = 'default') {
  const m = modelCache.get(name);
  if (m) {
    m.dispose();
    modelCache.delete(name);
  }
}

export async function deleteTattooSegModel(name = 'default') {
  disposeTattooSegModel(name);
  try {
    await tf.io.removeModel(modelKey(name));
  } catch {}
  // Also remove legacy key if deleting default
  if (name === 'default') {
    try { await tf.io.removeModel(LEGACY_KEY); } catch {}
  }
}

/**
 * List all stored tattoo seg model names.
 */
export async function listTattooSegModels() {
  try {
    const models = await tf.io.listModels();
    const names = [];
    for (const key of Object.keys(models)) {
      if (key.startsWith(KEY_PREFIX)) {
        names.push(key.slice(KEY_PREFIX.length));
      } else if (key === LEGACY_KEY) {
        names.push('default');
      }
    }
    // Deduplicate (legacy + new default)
    return [...new Set(names)];
  } catch {
    return [];
  }
}

// --- Inference ---

export async function predictTattooMask(model, sourceCanvas) {
  const { width: origW, height: origH } = sourceCanvas;

  // Resize to 256x256
  const resized = document.createElement('canvas');
  resized.width = SEG_SIZE;
  resized.height = SEG_SIZE;
  resized.getContext('2d').drawImage(sourceCanvas, 0, 0, SEG_SIZE, SEG_SIZE);

  const imgData = resized.getContext('2d').getImageData(0, 0, SEG_SIZE, SEG_SIZE).data;

  // Run inference
  const maskData = tf.tidy(() => {
    const rgba = tf.tensor3d(imgData, [SEG_SIZE, SEG_SIZE, 4]);
    const rgb = tf.slice(rgba, [0, 0, 0], [-1, -1, 3]);
    const input = tf.expandDims(tf.div(rgb, 255), 0);

    const output = model.predict(input); // [1, 256, 256, 1]
    return tf.squeeze(output).arraySync(); // [256, 256]
  });

  // Find prediction stats for adaptive thresholding
  let minVal = 1, maxVal = 0, sum = 0;
  const total = SEG_SIZE * SEG_SIZE;
  for (let y = 0; y < SEG_SIZE; y++) {
    for (let x = 0; x < SEG_SIZE; x++) {
      const v = maskData[y][x];
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
      sum += v;
    }
  }
  const meanVal = sum / total;
  console.log(`[TattooSeg] Prediction stats: min=${minVal.toFixed(3)} max=${maxVal.toFixed(3)} mean=${meanVal.toFixed(3)}`);

  // If predictions are nearly uniform (spread < 0.05), the model hasn't
  // learned spatial features yet — return null instead of a random mask
  const spread = maxVal - minVal;
  if (spread < 0.05) {
    console.log(`[TattooSeg] Predictions too uniform (spread=${spread.toFixed(4)}), need more training data`);
    return null;
  }

  // Adaptive threshold: use 0.5 if predictions are confident, otherwise
  // use midpoint between mean and max to salvage undertrained models
  let threshold = 0.5;
  if (maxVal < 0.5 && maxVal > 0.1) {
    threshold = (meanVal + maxVal) / 2;
    console.log(`[TattooSeg] Adaptive threshold: ${threshold.toFixed(3)} (model undertrained)`);
  }

  // Build mask canvas at original resolution
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = origW;
  maskCanvas.height = origH;

  // First draw at 256x256 then scale up
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = SEG_SIZE;
  tempCanvas.height = SEG_SIZE;
  const tempCtx = tempCanvas.getContext('2d');
  const tempImgData = tempCtx.createImageData(SEG_SIZE, SEG_SIZE);

  for (let y = 0; y < SEG_SIZE; y++) {
    for (let x = 0; x < SEG_SIZE; x++) {
      const i = (y * SEG_SIZE + x) * 4;
      const val = maskData[y][x];
      if (val > threshold) {
        tempImgData.data[i] = 255;     // R
        tempImgData.data[i + 1] = 255; // G
        tempImgData.data[i + 2] = 255; // B
        tempImgData.data[i + 3] = 255; // A — marks as masked
      } else {
        tempImgData.data[i + 3] = 0;   // transparent = not masked
      }
    }
  }
  tempCtx.putImageData(tempImgData, 0, 0);

  // Scale to original size with nearest-neighbor
  const maskCtx = maskCanvas.getContext('2d');
  maskCtx.imageSmoothingEnabled = false;
  maskCtx.drawImage(tempCanvas, 0, 0, origW, origH);

  return maskCanvas;
}

export { SEG_SIZE };
