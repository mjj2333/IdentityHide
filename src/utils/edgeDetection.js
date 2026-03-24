import { rgbToLab, isSkinPixel } from './imageHelpers';

/**
 * Sobel edge detection — foundation for Phase 2 tattoo detection.
 * Operates on ImageData, returns grayscale edge magnitude ImageData.
 */

export function sobelEdges(imageData) {
  const { width, height, data } = imageData;
  const output = new ImageData(width, height);
  const out = output.data;

  // Convert to grayscale first
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const p = i * 4;
    gray[i] = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
  }

  // Sobel kernels
  // Gx: [-1 0 1; -2 0 2; -1 0 1]
  // Gy: [-1 -2 -1; 0 0 0; 1 2 1]

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const tl = gray[(y - 1) * width + (x - 1)];
      const tc = gray[(y - 1) * width + x];
      const tr = gray[(y - 1) * width + (x + 1)];
      const ml = gray[y * width + (x - 1)];
      const mr = gray[y * width + (x + 1)];
      const bl = gray[(y + 1) * width + (x - 1)];
      const bc = gray[(y + 1) * width + x];
      const br = gray[(y + 1) * width + (x + 1)];

      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      const mag = Math.min(255, Math.sqrt(gx * gx + gy * gy));

      const i = (y * width + x) * 4;
      out[i] = mag;
      out[i + 1] = mag;
      out[i + 2] = mag;
      out[i + 3] = 255;
    }
  }

  return output;
}

/**
 * Pre-blur ImageData to suppress fine details before edge detection.
 * Multiple passes of 3x3 box blur approximate a Gaussian blur.
 */
function blurImageData(imageData, passes) {
  const { width, height } = imageData;
  let src = new Uint8ClampedArray(imageData.data);

  for (let pass = 0; pass < passes; pass++) {
    const dst = new Uint8ClampedArray(src);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              sum += src[((y + dy) * width + (x + dx)) * 4 + c];
            }
          }
          dst[i + c] = Math.round(sum / 9);
        }
      }
    }
    src = dst;
  }

  return new ImageData(src, width, height);
}

/**
 * Compute a normalized edge magnitude map from a source canvas.
 * Pre-blurs to suppress fine details (tattoo ink lines, texture) while
 * preserving strong structural edges (skin boundary, body outline).
 * Returns { map: Float32Array (0-1), width, height }.
 */
export function computeEdgeMap(sourceCanvas) {
  const { width, height } = sourceCanvas;
  const ctx = sourceCanvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, width, height);

  // Pre-blur: 2 passes of 3x3 ≈ 5x5 Gaussian, smooths tattoo detail edges
  const blurredSrc = blurImageData(imageData, 2);
  const edges = sobelEdges(blurredSrc);

  // Convert to normalized float array
  const map = new Float32Array(width * height);
  let maxMag = 0;
  for (let i = 0; i < map.length; i++) {
    map[i] = edges.data[i * 4];
    if (map[i] > maxMag) maxMag = map[i];
  }

  if (maxMag > 0) {
    for (let i = 0; i < map.length; i++) {
      map[i] /= maxMag;
    }
  }

  // Post-blur to thicken detected edges for more reliable ray barrier hits
  const thickened = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let maxVal = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = map[(y + dy) * width + (x + dx)];
          if (v > maxVal) maxVal = v;
        }
      }
      thickened[y * width + x] = maxVal;
    }
  }

  // Use the max-dilated version (widens edges by 1px in all directions)
  for (let i = 0; i < map.length; i++) {
    map[i] = Math.max(map[i], thickened[i]);
  }

  return { map, width, height };
}

/**
 * Horizontal box blur pass on a Float32Array. Mutates `out` in place.
 */
function boxBlurH(src, out, w, h, radius) {
  const diam = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    // Initialize window
    for (let x = -radius; x <= radius; x++) {
      sum += src[y * w + Math.max(0, Math.min(w - 1, x))];
    }
    for (let x = 0; x < w; x++) {
      out[y * w + x] = sum / diam;
      const addIdx = Math.min(w - 1, x + radius + 1);
      const subIdx = Math.max(0, x - radius);
      sum += src[y * w + addIdx] - src[y * w + subIdx];
    }
  }
}

/**
 * Vertical box blur pass on a Float32Array. Mutates `out` in place.
 */
function boxBlurV(src, out, w, h, radius) {
  const diam = radius * 2 + 1;
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) {
      sum += src[Math.max(0, Math.min(h - 1, y)) * w + x];
    }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / diam;
      const addIdx = Math.min(h - 1, y + radius + 1);
      const subIdx = Math.max(0, y - radius);
      sum += src[addIdx * w + x] - src[subIdx * w + x];
    }
  }
}

/**
 * Separable box blur (2 passes = approximate Gaussian).
 */
function boxBlur(arr, w, h, radius) {
  const tmp = new Float32Array(arr.length);
  boxBlurH(arr, tmp, w, h, radius);
  boxBlurV(tmp, arr, w, h, radius);
}

/**
 * Compute a per-pixel ink score (0-1) using LOCAL skin reference.
 * Builds a smooth skin color field by blurring only skin pixels,
 * then compares each pixel to its local expected skin color.
 * This handles lighting variation, shadows, and skin tone gradients.
 * Returns { map: Float32Array (0-1), width, height, skinLab }.
 */
export function computeInkMap(sourceCanvas) {
  const { width, height } = sourceCanvas;
  const ctx = sourceCanvas.getContext('2d');
  const data = ctx.getImageData(0, 0, width, height).data;
  const n = width * height;

  // Build per-pixel skin color channels + weight (1 if skin, 0 if not)
  const skinRArr = new Float32Array(n);
  const skinGArr = new Float32Array(n);
  const skinBArr = new Float32Array(n);
  const skinW = new Float32Array(n);
  let totalSkin = 0;

  for (let i = 0; i < n; i++) {
    const pi = i * 4;
    const r = data[pi], g = data[pi + 1], b = data[pi + 2];
    if (isSkinPixel(r, g, b)) {
      skinRArr[i] = r;
      skinGArr[i] = g;
      skinBArr[i] = b;
      skinW[i] = 1;
      totalSkin++;
    }
  }

  if (totalSkin < 100) {
    console.warn('[InkMap] Not enough skin pixels detected, ink map disabled');
    return { map: new Float32Array(n), width, height, skinLab: null };
  }

  // Global skin reference for logging
  let gR = 0, gG = 0, gB = 0;
  for (let i = 0; i < n; i++) {
    if (skinW[i]) { gR += skinRArr[i]; gG += skinGArr[i]; gB += skinBArr[i]; }
  }
  gR /= totalSkin; gG /= totalSkin; gB /= totalSkin;
  const skinLab = rgbToLab(gR, gG, gB);
  console.log(`[InkMap] Skin: ${totalSkin} px, global RGB(${gR.toFixed(0)}, ${gG.toFixed(0)}, ${gB.toFixed(0)}), LAB(${skinLab[0].toFixed(1)}, ${skinLab[1].toFixed(1)}, ${skinLab[2].toFixed(1)})`);

  // Blur skin channels + weight with large radius to create smooth local reference
  // Use ~5% of image diagonal as blur radius
  const BLUR_RADIUS = Math.max(32, Math.round(Math.sqrt(width * width + height * height) * 0.05));
  console.log(`[InkMap] Local blur radius: ${BLUR_RADIUS}px`);

  boxBlur(skinRArr, width, height, BLUR_RADIUS);
  boxBlur(skinGArr, width, height, BLUR_RADIUS);
  boxBlur(skinBArr, width, height, BLUR_RADIUS);
  boxBlur(skinW, width, height, BLUR_RADIUS);

  // Compute per-pixel LAB distance from local skin reference
  const INK_LOW = 8;
  const INK_HIGH = 18;
  const map = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const w = skinW[i];
    if (w < 0.01) {
      // No nearby skin — use global reference
      const pi = i * 4;
      const lab = rgbToLab(data[pi], data[pi + 1], data[pi + 2]);
      const dL = lab[0] - skinLab[0];
      const dA = lab[1] - skinLab[1];
      const dB = lab[2] - skinLab[2];
      const d = Math.sqrt(dL * dL + dA * dA + dB * dB);
      if (d <= INK_LOW) map[i] = 0;
      else if (d >= INK_HIGH) map[i] = 1;
      else { const t = (d - INK_LOW) / (INK_HIGH - INK_LOW); map[i] = t * t * (3 - 2 * t); }
      continue;
    }

    // Local skin reference from blurred field
    const localR = skinRArr[i] / w;
    const localG = skinGArr[i] / w;
    const localB = skinBArr[i] / w;
    const localLab = rgbToLab(localR, localG, localB);

    const pi = i * 4;
    const lab = rgbToLab(data[pi], data[pi + 1], data[pi + 2]);
    const dL = lab[0] - localLab[0];
    const dA = lab[1] - localLab[1];
    const dB = lab[2] - localLab[2];
    const d = Math.sqrt(dL * dL + dA * dA + dB * dB);

    if (d <= INK_LOW) {
      map[i] = 0;
    } else if (d >= INK_HIGH) {
      map[i] = 1;
    } else {
      const t = (d - INK_LOW) / (INK_HIGH - INK_LOW);
      map[i] = t * t * (3 - 2 * t);
    }
  }

  // Body mask: pixels with nearby skin (skinW above threshold after blur)
  // Prevents brush from painting on background (white/black/colored backdrop)
  const BODY_THRESHOLD = 0.20;
  const bodyMask = new Uint8Array(n);
  let bodyCount = 0;
  for (let i = 0; i < n; i++) {
    if (skinW[i] >= BODY_THRESHOLD) { bodyMask[i] = 1; bodyCount++; }
  }
  console.log(`[InkMap] Body mask: ${bodyCount}/${n} px (${(bodyCount/n*100).toFixed(1)}%)`);

  return { map, width, height, skinLab, bodyMask };
}
