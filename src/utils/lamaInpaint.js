/**
 * LaMa (Large Mask Inpainting) via ONNX Runtime WebGPU backend.
 *
 * Uses the dedicated WebGPU entry point for GPU-accelerated inference
 * with automatic CPU fallback for unsupported ops (Shape, Einsum, etc.).
 * Works on Chrome, Edge, iOS 26+, modern Android.
 */
import * as ort from 'onnxruntime-web/webgpu';
import { isSkinPixel } from './imageHelpers.js';

const MODEL_PATH = '/models/lama_fp32.onnx';
const LAMA_SIZE = 512;

let session = null;
let initPromise = null;

// Preserve loaded model across Vite HMR (dev only)
if (import.meta.hot) {
  if (import.meta.hot.data?.session) {
    session = import.meta.hot.data.session;
    console.log('[LaMa] Restored session from HMR');
  }
  import.meta.hot.dispose((data) => {
    data.session = session;
  });
}

export async function initLaMa() {
  if (session) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      console.log('[LaMa] Loading model (WebGPU)…');
      const t0 = performance.now();
      session = await ort.InferenceSession.create(MODEL_PATH, {
        executionProviders: ['webgpu'],
      });
      console.log(`[LaMa] Loaded in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      console.log('[LaMa] Inputs:', session.inputNames, 'Outputs:', session.outputNames);

      // Warmup: run one dummy inference to force GPU shader compilation
      // and buffer allocation. Without this, the first real inference can
      // produce corrupted output from uninitialized WebGPU buffers.
      const sz = LAMA_SIZE * LAMA_SIZE;
      const warmImg = new ort.Tensor('float32', new Float32Array(3 * sz), [1, 3, LAMA_SIZE, LAMA_SIZE]);
      const warmMsk = new ort.Tensor('float32', new Float32Array(sz).fill(1), [1, 1, LAMA_SIZE, LAMA_SIZE]);
      const tw = performance.now();
      await session.run({ [session.inputNames[0]]: warmImg, [session.inputNames[1]]: warmMsk });
      console.log(`[LaMa] Warmup inference ${(performance.now() - tw).toFixed(0)}ms`);

      return true;
    } catch (err) {
      console.warn('[LaMa] Failed to load:', err.message);
      initPromise = null;
      session = null;
      return false;
    }
  })();

  return initPromise;
}


/**
 * RGB to CIELAB for perceptually uniform distance measurements.
 */
function rgbToLab(r, g, b) {
  let rr = r / 255, gg = g / 255, bb = b / 255;
  rr = rr > 0.04045 ? ((rr + 0.055) / 1.055) ** 2.4 : rr / 12.92;
  gg = gg > 0.04045 ? ((gg + 0.055) / 1.055) ** 2.4 : gg / 12.92;
  bb = bb > 0.04045 ? ((bb + 0.055) / 1.055) ** 2.4 : bb / 12.92;
  let x = (rr * 0.4124564 + gg * 0.3575761 + bb * 0.1804375) / 0.95047;
  let y = rr * 0.2126729 + gg * 0.7151522 + bb * 0.0721750;
  let z = (rr * 0.0193339 + gg * 0.1191920 + bb * 0.9503041) / 1.08883;
  const f = t => t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116;
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/**
 * CIELAB to RGB for color correction.
 */
function labToRgb(L, a, b) {
  let y = (L + 16) / 116;
  let x = a / 500 + y;
  let z = y - b / 200;
  const finv = t => t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787;
  x = finv(x) * 0.95047;
  y = finv(y);
  z = finv(z) * 1.08883;
  let rr = x *  3.2404542 + y * -1.5371385 + z * -0.4985314;
  let gg = x * -0.9692660 + y *  1.8760108 + z *  0.0415560;
  let bb = x *  0.0556434 + y * -0.2040259 + z *  1.0572252;
  const gamma = c => c > 0.0031308 ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : 12.92 * c;
  return [
    Math.round(Math.min(255, Math.max(0, gamma(rr) * 255))),
    Math.round(Math.min(255, Math.max(0, gamma(gg) * 255))),
    Math.round(Math.min(255, Math.max(0, gamma(bb) * 255))),
  ];
}

/**
 * Inpaint a region using LaMa.
 *
 * @param {Uint8Array} regionPixels – RGBA pixels (rw × rh × 4)
 * @param {Uint8Array} regionMask  – Binary mask 0/1 (rw × rh)
 * @param {number} rw – Region width
 * @param {number} rh – Region height
 * @returns {Uint8Array} – Inpainted RGBA pixels (rw × rh × 4)
 */
export async function lamaInpaintRegion(regionPixels, regionMask, rw, rh, { featherRadius = 16 } = {}) {
  if (!session) {
    const ok = await initLaMa();
    if (!ok) throw new Error('LaMa model not available');
  }

  const totalPx = rw * rh;
  const originalMaskCount = regionMask.reduce((s, v) => s + v, 0);
  console.log(`[LaMa DIAG] ===== Region ${rw}x${rh} (${totalPx} px) =====`);
  console.log(`[LaMa DIAG] Original mask: ${originalMaskCount} px (${(originalMaskCount/totalPx*100).toFixed(1)}% of region)`);
  console.log(`[LaMa DIAG] Mask-to-512 scale: ${(rw/LAMA_SIZE).toFixed(2)}x${(rh/LAMA_SIZE).toFixed(2)} (aspect ${(rw/rh).toFixed(2)})`);

  // --- Analyze input context (what LaMa will see outside the mask) ---
  let ctxSkin = 0, ctxNonSkin = 0, ctxDark = 0, ctxBright = 0;
  const ctxColorBuckets = { red: 0, green: 0, blue: 0, warm: 0, neutral: 0 };
  for (let i = 0; i < totalPx; i++) {
    if (regionMask[i]) continue;
    const pi = i * 4;
    const r = regionPixels[pi], g = regionPixels[pi + 1], b = regionPixels[pi + 2];
    const brightness = r * 0.299 + g * 0.587 + b * 0.114;
    if (brightness < 30) ctxDark++;
    if (brightness > 230) ctxBright++;
    if (isSkinPixel(r, g, b)) {
      ctxSkin++;
    } else {
      ctxNonSkin++;
      // Classify non-skin pixels
      if (b > r && b > g) ctxColorBuckets.blue++;
      else if (g > r && g > b) ctxColorBuckets.green++;
      else if (r > g + 30 && r > b + 30) ctxColorBuckets.red++;
      else if (r > b + 10) ctxColorBuckets.warm++;
      else ctxColorBuckets.neutral++;
    }
  }
  const ctxTotal = ctxSkin + ctxNonSkin;
  console.log(`[LaMa DIAG] Context pixels: ${ctxTotal} (skin: ${ctxSkin} (${(ctxSkin/ctxTotal*100).toFixed(1)}%), non-skin: ${ctxNonSkin} (${(ctxNonSkin/ctxTotal*100).toFixed(1)}%))`);
  console.log(`[LaMa DIAG] Context: dark(<30)=${ctxDark}, bright(>230)=${ctxBright}`);
  console.log(`[LaMa DIAG] Non-skin breakdown: blue=${ctxColorBuckets.blue}, green=${ctxColorBuckets.green}, red=${ctxColorBuckets.red}, warm=${ctxColorBuckets.warm}, neutral=${ctxColorBuckets.neutral}`);

  // --- Analyze what's UNDER the mask (the tattoo) ---
  let inkR = 0, inkG = 0, inkB = 0;
  const inkLabs = [];
  let inkDarkCount = 0, inkSkinLikeCount = 0;
  for (let i = 0; i < totalPx; i++) {
    if (!regionMask[i]) continue;
    const pi = i * 4;
    const r = regionPixels[pi], g = regionPixels[pi + 1], b = regionPixels[pi + 2];
    inkR += r; inkG += g; inkB += b;
    const brightness = r * 0.299 + g * 0.587 + b * 0.114;
    if (brightness < 60) inkDarkCount++;
    if (isSkinPixel(r, g, b)) inkSkinLikeCount++;
    if (inkLabs.length < 500) inkLabs.push(rgbToLab(r, g, b)); // sample for histogram
  }
  if (originalMaskCount > 0) {
    inkR /= originalMaskCount; inkG /= originalMaskCount; inkB /= originalMaskCount;
  }
  console.log(`[LaMa DIAG] Under mask (tattoo): mean RGB(${inkR.toFixed(0)}, ${inkG.toFixed(0)}, ${inkB.toFixed(0)}), dark(<60): ${inkDarkCount} (${(inkDarkCount/originalMaskCount*100).toFixed(1)}%), skin-like: ${inkSkinLikeCount} (${(inkSkinLikeCount/originalMaskCount*100).toFixed(1)}%)`);

  // Use pipeline dilation as base, then auto-expand border into non-skin
  // so LaMa's immediate context is always skin.
  const dilatedMask = new Uint8Array(regionMask);
  const baseMaskCount = dilatedMask.reduce((s, v) => s + v, 0);
  console.log(`[LaMa DIAG] Base mask: ${baseMaskCount} px (${(baseMaskCount/totalPx*100).toFixed(1)}% of region)`);

  // Iteratively expand mask border into non-skin pixels until border is
  // all skin (or we hit the expansion limit). This ensures LaMa's first
  // row of context is real skin, not sand/wall/background.
  const BORDER_EXPAND_LIMIT = 15; // max px to nibble outward
  let totalExpanded = 0;
  for (let iter = 0; iter < BORDER_EXPAND_LIMIT; iter++) {
    const toAdd = [];
    for (let i = 0; i < totalPx; i++) {
      if (dilatedMask[i]) continue;
      const x = i % rw, y = Math.floor(i / rw);
      let adjMask = false;
      if (x > 0 && dilatedMask[i - 1]) adjMask = true;
      if (x < rw - 1 && dilatedMask[i + 1]) adjMask = true;
      if (y > 0 && dilatedMask[i - rw]) adjMask = true;
      if (y < rh - 1 && dilatedMask[i + rw]) adjMask = true;
      if (!adjMask) continue;
      const pi = i * 4;
      if (!isSkinPixel(regionPixels[pi], regionPixels[pi + 1], regionPixels[pi + 2])) {
        toAdd.push(i);
      }
    }
    if (toAdd.length === 0) break; // border is all skin — done
    for (const idx of toAdd) dilatedMask[idx] = 1;
    totalExpanded += toAdd.length;
  }
  const dilatedTotal = dilatedMask.reduce((s, v) => s + v, 0);
  if (totalExpanded > 0) {
    console.log(`[LaMa DIAG] Border auto-expanded ${totalExpanded} non-skin px → mask now ${dilatedTotal} px (${(dilatedTotal/totalPx*100).toFixed(1)}%)`);
  }

  // --- Analyze the mask border (pixels just outside dilated mask) ---
  let borderSkin = 0, borderNonSkin = 0;
  const borderNonSkinColors = [];
  for (let i = 0; i < totalPx; i++) {
    if (dilatedMask[i]) continue;
    const x = i % rw, y = Math.floor(i / rw);
    let adjMask = false;
    if (x > 0 && dilatedMask[i - 1]) adjMask = true;
    if (x < rw - 1 && dilatedMask[i + 1]) adjMask = true;
    if (y > 0 && dilatedMask[i - rw]) adjMask = true;
    if (y < rh - 1 && dilatedMask[i + rw]) adjMask = true;
    if (!adjMask) continue;
    const pi = i * 4;
    const r = regionPixels[pi], g = regionPixels[pi + 1], b = regionPixels[pi + 2];
    if (isSkinPixel(r, g, b)) {
      borderSkin++;
    } else {
      borderNonSkin++;
      if (borderNonSkinColors.length < 20) {
        borderNonSkinColors.push(`RGB(${r},${g},${b})`);
      }
    }
  }
  const borderTotal = borderSkin + borderNonSkin;
  console.log(`[LaMa DIAG] Mask border (adjacent unmasked): ${borderTotal} px, skin=${borderSkin} (${(borderSkin/borderTotal*100).toFixed(1)}%), non-skin=${borderNonSkin} (${(borderNonSkin/borderTotal*100).toFixed(1)}%)`);
  if (borderNonSkinColors.length > 0) {
    console.log(`[LaMa DIAG] Border non-skin samples: ${borderNonSkinColors.slice(0, 10).join(', ')}`);
  }

  // Compute reference color from non-masked skin pixels only
  let refR = 0, refG = 0, refB = 0, refCount = 0;
  let refMinR = 255, refMaxR = 0, refMinG = 255, refMaxG = 0, refMinB = 255, refMaxB = 0;
  for (let i = 0; i < totalPx; i++) {
    if (!dilatedMask[i]) {
      const pi = i * 4;
      const r = regionPixels[pi], g = regionPixels[pi + 1], b = regionPixels[pi + 2];
      if (isSkinPixel(r, g, b)) {
        refR += r; refG += g; refB += b;
        refCount++;
        if (r < refMinR) refMinR = r; if (r > refMaxR) refMaxR = r;
        if (g < refMinG) refMinG = g; if (g > refMaxG) refMaxG = g;
        if (b < refMinB) refMinB = b; if (b > refMaxB) refMaxB = b;
      }
    }
  }
  if (refCount > 0) { refR /= refCount; refG /= refCount; refB /= refCount; }
  const refLab = rgbToLab(Math.round(refR), Math.round(refG), Math.round(refB));
  console.log(`[LaMa DIAG] Reference skin: ${refCount} px, mean RGB(${refR.toFixed(0)}, ${refG.toFixed(0)}, ${refB.toFixed(0)}), LAB(${refLab[0].toFixed(1)}, ${refLab[1].toFixed(1)}, ${refLab[2].toFixed(1)})`);
  console.log(`[LaMa DIAG] Reference range: R[${refMinR}-${refMaxR}], G[${refMinG}-${refMaxG}], B[${refMinB}-${refMaxB}]`);

  // No context preprocessing — standard LaMa handles complex backgrounds natively.

  // BFS context cleanup: DISABLED — progressive inpainting + exclusion mask
  // handle bad context better than replacing real texture with flat propagated skin.
  if (false && refCount > 0) {
    const cleaned = new Uint8Array(regionPixels);
    const wasSkin = new Uint8Array(totalPx);
    const filled = new Uint8Array(totalPx);
    const queue = [];

    // Seed with unmasked skin pixels
    for (let i = 0; i < totalPx; i++) {
      if (dilatedMask[i]) { filled[i] = 1; continue; }
      const pi = i * 4;
      if (isSkinPixel(cleaned[pi], cleaned[pi + 1], cleaned[pi + 2])) {
        filled[i] = 1;
        wasSkin[i] = 1;
        queue.push(i);
      }
    }

    // BFS: propagate nearest skin color into non-skin context areas
    let qi = 0;
    let replacedCtx = 0;
    while (qi < queue.length) {
      const idx = queue[qi++];
      const x = idx % rw, y = Math.floor(idx / rw);
      const pi = idx * 4;
      const sr = cleaned[pi], sg = cleaned[pi + 1], sb = cleaned[pi + 2];

      if (x > 0)      { const ni = idx - 1;  if (!filled[ni]) { cleaned[ni * 4] = sr; cleaned[ni * 4 + 1] = sg; cleaned[ni * 4 + 2] = sb; filled[ni] = 1; replacedCtx++; queue.push(ni); } }
      if (x < rw - 1) { const ni = idx + 1;  if (!filled[ni]) { cleaned[ni * 4] = sr; cleaned[ni * 4 + 1] = sg; cleaned[ni * 4 + 2] = sb; filled[ni] = 1; replacedCtx++; queue.push(ni); } }
      if (y > 0)      { const ni = idx - rw; if (!filled[ni]) { cleaned[ni * 4] = sr; cleaned[ni * 4 + 1] = sg; cleaned[ni * 4 + 2] = sb; filled[ni] = 1; replacedCtx++; queue.push(ni); } }
      if (y < rh - 1) { const ni = idx + rw; if (!filled[ni]) { cleaned[ni * 4] = sr; cleaned[ni * 4 + 1] = sg; cleaned[ni * 4 + 2] = sb; filled[ni] = 1; replacedCtx++; queue.push(ni); } }
    }

    // Fill any remaining unreachable pixels with reference skin color
    const skinR = Math.round(refR), skinG = Math.round(refG), skinB = Math.round(refB);
    for (let i = 0; i < totalPx; i++) {
      if (!filled[i]) {
        cleaned[i * 4] = skinR; cleaned[i * 4 + 1] = skinG; cleaned[i * 4 + 2] = skinB;
        replacedCtx++;
      }
    }

    // Smooth BFS-filled pixels to soften Voronoi boundaries
    const smoothed = new Uint8Array(cleaned);
    for (let i = 0; i < totalPx; i++) {
      if (dilatedMask[i] || wasSkin[i]) continue;
      const x = i % rw, y = Math.floor(i / rw);
      let sumR = 0, sumG = 0, sumB = 0, cnt = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= rw || ny < 0 || ny >= rh) continue;
          const ni = ny * rw + nx;
          if (dilatedMask[ni]) continue;
          sumR += cleaned[ni * 4]; sumG += cleaned[ni * 4 + 1]; sumB += cleaned[ni * 4 + 2];
          cnt++;
        }
      }
      if (cnt > 0) {
        smoothed[i * 4] = Math.round(sumR / cnt);
        smoothed[i * 4 + 1] = Math.round(sumG / cnt);
        smoothed[i * 4 + 2] = Math.round(sumB / cnt);
      }
    }

    regionPixels = smoothed;
    console.log(`[LaMa DIAG] Context cleanup: propagated skin into ${replacedCtx} non-skin context px (BFS + smoothed)`);
  }

  // --- Pad to square, then resize to 512×512 (preserves aspect ratio) ---
  const sqSize = Math.max(rw, rh);
  const padX = Math.floor((sqSize - rw) / 2);
  const padY = Math.floor((sqSize - rh) / 2);
  console.log(`[LaMa DIAG] Padding ${rw}x${rh} → ${sqSize}x${sqSize} (pad +${padX},+${padY}), scale ${(sqSize/LAMA_SIZE).toFixed(2)}x`);

  // Build mask on square canvas (unmasked padding = 0, so LaMa treats it as context)
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = rw;
  maskCanvas.height = rh;
  const maskCtx = maskCanvas.getContext('2d');
  const maskImgData = maskCtx.createImageData(rw, rh);
  for (let i = 0; i < totalPx; i++) {
    const v = dilatedMask[i] ? 255 : 0;
    maskImgData.data[i * 4] = v;
    maskImgData.data[i * 4 + 1] = v;
    maskImgData.data[i * 4 + 2] = v;
    maskImgData.data[i * 4 + 3] = 255;
  }
  maskCtx.putImageData(maskImgData, 0, 0);

  // Square mask canvas — padding is black (0 = unmasked context)
  const sqMask = document.createElement('canvas');
  sqMask.width = sqSize;
  sqMask.height = sqSize;
  const sqMaskCtx = sqMask.getContext('2d');
  sqMaskCtx.fillStyle = '#000';
  sqMaskCtx.fillRect(0, 0, sqSize, sqSize);
  sqMaskCtx.drawImage(maskCanvas, padX, padY);

  const resizedMask = document.createElement('canvas');
  resizedMask.width = LAMA_SIZE;
  resizedMask.height = LAMA_SIZE;
  const rmCtx = resizedMask.getContext('2d');
  rmCtx.imageSmoothingEnabled = false;
  rmCtx.drawImage(sqMask, 0, 0, LAMA_SIZE, LAMA_SIZE);

  const maskPixels = rmCtx.getImageData(0, 0, LAMA_SIZE, LAMA_SIZE).data;
  const ch = LAMA_SIZE * LAMA_SIZE;
  const maskFloat = new Float32Array(ch);
  let mask512Count = 0;
  for (let i = 0; i < ch; i++) {
    maskFloat[i] = maskPixels[i * 4] > 128 ? 1.0 : 0.0;
    if (maskFloat[i]) mask512Count++;
  }
  console.log(`[LaMa DIAG] Mask at 512x512: ${mask512Count} px (${(mask512Count/ch*100).toFixed(1)}%)`);

  // Build image on square canvas — pad edges by mirroring border pixels
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = rw;
  srcCanvas.height = rh;
  const srcCtx = srcCanvas.getContext('2d');
  const srcImgData = srcCtx.createImageData(rw, rh);
  srcImgData.data.set(regionPixels);
  srcCtx.putImageData(srcImgData, 0, 0);

  const sqSrc = document.createElement('canvas');
  sqSrc.width = sqSize;
  sqSrc.height = sqSize;
  const sqSrcCtx = sqSrc.getContext('2d');
  // Draw the actual image centered
  sqSrcCtx.drawImage(srcCanvas, padX, padY);
  // Mirror-fill padding: reflect the image at each edge
  if (padX > 0) {
    sqSrcCtx.save();
    // Left pad: mirror the left strip of the image
    sqSrcCtx.translate(padX, 0);
    sqSrcCtx.scale(-1, 1);
    sqSrcCtx.drawImage(srcCanvas, 0, 0, Math.min(padX, rw), rh, 0, padY, Math.min(padX, rw), rh);
    sqSrcCtx.restore();
    // Right pad: mirror the right strip
    sqSrcCtx.save();
    sqSrcCtx.translate(padX + rw, 0);
    sqSrcCtx.scale(-1, 1);
    sqSrcCtx.drawImage(srcCanvas, Math.max(0, rw - padX), 0, Math.min(padX, rw), rh, -Math.min(padX, rw), padY, Math.min(padX, rw), rh);
    sqSrcCtx.restore();
  }
  if (padY > 0) {
    sqSrcCtx.save();
    // Top pad: mirror the top strip (of the full-width row including side pads)
    sqSrcCtx.translate(0, padY);
    sqSrcCtx.scale(1, -1);
    sqSrcCtx.drawImage(sqSrc, 0, padY, sqSize, Math.min(padY, rh), 0, 0, sqSize, Math.min(padY, rh));
    sqSrcCtx.restore();
    // Bottom pad: mirror the bottom strip
    sqSrcCtx.save();
    sqSrcCtx.translate(0, padY + rh);
    sqSrcCtx.scale(1, -1);
    sqSrcCtx.drawImage(sqSrc, 0, padY + rh - Math.min(padY, rh), sqSize, Math.min(padY, rh), -0, 0, sqSize, Math.min(padY, rh));
    sqSrcCtx.restore();
  }

  const workCanvas = document.createElement('canvas');
  workCanvas.width = LAMA_SIZE;
  workCanvas.height = LAMA_SIZE;
  const workCtx = workCanvas.getContext('2d');
  workCtx.drawImage(sqSrc, 0, 0, LAMA_SIZE, LAMA_SIZE);

  // Helper: run one LaMa inference, copy masked pixels from output into workCtx
  const runLamaPass = async (mask512, zeroMasked, label) => {
    const curData = workCtx.getImageData(0, 0, LAMA_SIZE, LAMA_SIZE);
    const imageFloat = new Float32Array(3 * ch);
    for (let i = 0; i < ch; i++) {
      const pi = i * 4;
      if (zeroMasked && mask512[i] > 0.5) {
        imageFloat[i] = 0;
        imageFloat[ch + i] = 0;
        imageFloat[2 * ch + i] = 0;
      } else {
        imageFloat[i] = curData.data[pi] / 255;
        imageFloat[ch + i] = curData.data[pi + 1] / 255;
        imageFloat[2 * ch + i] = curData.data[pi + 2] / 255;
      }
    }
    const imageTensor = new ort.Tensor('float32', imageFloat, [1, 3, LAMA_SIZE, LAMA_SIZE]);
    const mTensor = new ort.Tensor('float32', new Float32Array(mask512), [1, 1, LAMA_SIZE, LAMA_SIZE]);
    const t0 = performance.now();
    const results = await session.run({
      [session.inputNames[0]]: imageTensor,
      [session.inputNames[1]]: mTensor,
    });
    console.log(`[LaMa] ${label}: ${(performance.now() - t0).toFixed(0)}ms`);
    const outData = results[session.outputNames[0]].data;
    let outMax = 0;
    for (let i = 0; i < Math.min(100, outData.length); i++) outMax = Math.max(outMax, outData[i]);
    const isFloat01 = outMax <= 1.5;
    // Copy masked pixels from output into working image
    for (let i = 0; i < ch; i++) {
      if (mask512[i] < 0.5) continue;
      const pi = i * 4;
      if (isFloat01) {
        curData.data[pi]     = Math.round(Math.min(1, Math.max(0, outData[i])) * 255);
        curData.data[pi + 1] = Math.round(Math.min(1, Math.max(0, outData[ch + i])) * 255);
        curData.data[pi + 2] = Math.round(Math.min(1, Math.max(0, outData[2 * ch + i])) * 255);
      } else {
        curData.data[pi]     = Math.round(Math.min(255, Math.max(0, outData[i])));
        curData.data[pi + 1] = Math.round(Math.min(255, Math.max(0, outData[ch + i])));
        curData.data[pi + 2] = Math.round(Math.min(255, Math.max(0, outData[2 * ch + i])));
      }
    }
    workCtx.putImageData(curData, 0, 0);
    return { outData, isFloat01 };
  };

  if (true) {
    // ========== STANDARD LAMA: single pass with mask zeroing ==========
    // This is how LaMa was trained: img * (1-mask) + mask → output
    await runLamaPass(maskFloat, true, 'Single pass (standard)');
  } else {
    // ========== PROGRESSIVE: onion-peel bands + refinement pass ==========
    const BAND_WIDTH = 25;

    // Zero masked pixels for progressive (bands need clean zeros)
    const initData = workCtx.getImageData(0, 0, LAMA_SIZE, LAMA_SIZE);
    for (let i = 0; i < ch; i++) {
      if (maskFloat[i] > 0.5) {
        initData.data[i * 4] = 0;
        initData.data[i * 4 + 1] = 0;
        initData.data[i * 4 + 2] = 0;
      }
    }
    workCtx.putImageData(initData, 0, 0);

    // Compute distance transform via BFS from unmasked pixels into mask
    const distMap = new Float32Array(ch);
    const bfsQ = [];
    for (let i = 0; i < ch; i++) {
      if (maskFloat[i] < 0.5) { distMap[i] = 0; bfsQ.push(i); }
      else { distMap[i] = 1e9; }
    }
    let bfsI = 0;
    while (bfsI < bfsQ.length) {
      const idx = bfsQ[bfsI++];
      const x = idx % LAMA_SIZE, y = Math.floor(idx / LAMA_SIZE);
      const d = distMap[idx] + 1;
      if (x > 0 && d < distMap[idx - 1]) { distMap[idx - 1] = d; bfsQ.push(idx - 1); }
      if (x < LAMA_SIZE - 1 && d < distMap[idx + 1]) { distMap[idx + 1] = d; bfsQ.push(idx + 1); }
      if (y > 0 && d < distMap[idx - LAMA_SIZE]) { distMap[idx - LAMA_SIZE] = d; bfsQ.push(idx - LAMA_SIZE); }
      if (y < LAMA_SIZE - 1 && d < distMap[idx + LAMA_SIZE]) { distMap[idx + LAMA_SIZE] = d; bfsQ.push(idx + LAMA_SIZE); }
    }

    let maxDist = 0;
    for (let i = 0; i < ch; i++) if (distMap[i] < 1e9 && distMap[i] > maxDist) maxDist = distMap[i];
    const numBands = Math.ceil(maxDist / BAND_WIDTH);
    console.log(`[LaMa] Progressive: ${numBands} bands, max depth ${Math.round(maxDist)}px`);

    const remainingMask = new Float32Array(maskFloat);

    for (let band = 0; band < numBands; band++) {
      const dMin = band * BAND_WIDTH + 1;
      const dMax = (band + 1) * BAND_WIDTH;
      const bandPixelIndices = [];
      for (let i = 0; i < ch; i++) {
        if (distMap[i] >= dMin && distMap[i] <= dMax && distMap[i] < 1e9) bandPixelIndices.push(i);
      }
      if (bandPixelIndices.length === 0) continue;

      console.log(`[LaMa] Band ${band + 1}/${numBands}: depth ${dMin}-${dMax}px, ${bandPixelIndices.length} px`);

      // Run LaMa with remaining mask (zeroed), only keep this band's pixels
      const curData = workCtx.getImageData(0, 0, LAMA_SIZE, LAMA_SIZE);
      const imageFloat = new Float32Array(3 * ch);
      for (let i = 0; i < ch; i++) {
        const pi = i * 4;
        if (remainingMask[i] > 0.5) {
          imageFloat[i] = 0; imageFloat[ch + i] = 0; imageFloat[2 * ch + i] = 0;
        } else {
          imageFloat[i] = curData.data[pi] / 255;
          imageFloat[ch + i] = curData.data[pi + 1] / 255;
          imageFloat[2 * ch + i] = curData.data[pi + 2] / 255;
        }
      }
      const imageTensor = new ort.Tensor('float32', imageFloat, [1, 3, LAMA_SIZE, LAMA_SIZE]);
      const bandMaskTensor = new ort.Tensor('float32', new Float32Array(remainingMask), [1, 1, LAMA_SIZE, LAMA_SIZE]);
      const t0 = performance.now();
      const results = await session.run({
        [session.inputNames[0]]: imageTensor,
        [session.inputNames[1]]: bandMaskTensor,
      });
      console.log(`[LaMa]   Band ${band + 1} inference: ${(performance.now() - t0).toFixed(0)}ms`);
      const outData = results[session.outputNames[0]].data;
      let outMax = 0;
      for (let i = 0; i < Math.min(100, outData.length); i++) outMax = Math.max(outMax, outData[i]);
      const isFloat01 = outMax <= 1.5;
      for (const i of bandPixelIndices) {
        const pi = i * 4;
        if (isFloat01) {
          curData.data[pi]     = Math.round(Math.min(1, Math.max(0, outData[i])) * 255);
          curData.data[pi + 1] = Math.round(Math.min(1, Math.max(0, outData[ch + i])) * 255);
          curData.data[pi + 2] = Math.round(Math.min(1, Math.max(0, outData[2 * ch + i])) * 255);
        } else {
          curData.data[pi]     = Math.round(Math.min(255, Math.max(0, outData[i])));
          curData.data[pi + 1] = Math.round(Math.min(255, Math.max(0, outData[ch + i])));
          curData.data[pi + 2] = Math.round(Math.min(255, Math.max(0, outData[2 * ch + i])));
        }
        remainingMask[i] = 0;
      }
      workCtx.putImageData(curData, 0, 0);
    }

    // Final refinement: all bands filled, run LaMa once more with progressive output
    // visible (not zeroed) so it can refine the result with full context
    console.log(`[LaMa] Progressive refinement pass...`);
    await runLamaPass(maskFloat, false, 'Refinement (progressive output as context)');
  }

  // Resize 512×512 result back to square, then extract original region (undo padding)
  const sqOut = document.createElement('canvas');
  sqOut.width = sqSize;
  sqOut.height = sqSize;
  sqOut.getContext('2d').drawImage(workCanvas, 0, 0, sqSize, sqSize);

  const finalCanvas = document.createElement('canvas');
  finalCanvas.width = rw;
  finalCanvas.height = rh;
  finalCanvas.getContext('2d').drawImage(sqOut, padX, padY, rw, rh, 0, 0, rw, rh);
  let currentPixels = new Uint8Array(finalCanvas.getContext('2d').getImageData(0, 0, rw, rh).data.buffer);

  // Adaptive per-pixel LAB correction: DISABLED — flattens natural skin variation.
  // Progressive + exclusion mask handle color contamination at the source.
  if (false && refCount > 0) {
    const LAB_DEAD_ZONE = 8;  // pixels within this distance are fine
    const LAB_PULL_SCALE = 35; // controls how quickly pull strength ramps up
    const LAB_MAX_STRENGTH = 0.85;
    let corrected = 0, maxPull = 0;
    for (let i = 0; i < totalPx; i++) {
      if (!dilatedMask[i]) continue;
      const pi = i * 4;
      const lab = rgbToLab(currentPixels[pi], currentPixels[pi + 1], currentPixels[pi + 2]);
      const dist = Math.sqrt(
        (lab[0] - refLab[0]) ** 2 +
        (lab[1] - refLab[1]) ** 2 +
        (lab[2] - refLab[2]) ** 2
      );
      if (dist <= LAB_DEAD_ZONE) continue;
      const strength = Math.min(LAB_MAX_STRENGTH, (dist - LAB_DEAD_ZONE) / LAB_PULL_SCALE);
      const newL = lab[0] + (refLab[0] - lab[0]) * strength;
      const newA = lab[1] + (refLab[1] - lab[1]) * strength;
      const newB = lab[2] + (refLab[2] - lab[2]) * strength;
      const rgb = labToRgb(newL, newA, newB);
      currentPixels[pi] = rgb[0];
      currentPixels[pi + 1] = rgb[1];
      currentPixels[pi + 2] = rgb[2];
      corrected++;
      if (strength > maxPull) maxPull = strength;
    }
    if (corrected > 0) {
      console.log(`[LaMa DIAG] Adaptive LAB correction: ${corrected}px corrected, max pull=${maxPull.toFixed(2)}`);
    }
  }

  return currentPixels;
}
