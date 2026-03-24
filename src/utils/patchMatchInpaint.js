/**
 * PatchMatch-based inpainting engine for tattoo removal.
 *
 * Uses a coarse-to-fine image pyramid with randomized nearest-neighbor
 * patch matching in LAB color space for perceptually accurate results.
 *
 * Algorithm:
 *   1. Build image pyramid (3 levels)
 *   2. At each level (coarsest first):
 *      a. Initialize NNF (nearest neighbor field) randomly
 *      b. Iterate: propagation + random search
 *      c. Fill masked pixels from best matching patches
 *   3. Upsample NNF to next finer level
 */

const PATCH_SIZE = 7;
const HALF_PATCH = Math.floor(PATCH_SIZE / 2);
const NUM_ITERATIONS = 10;
const NUM_PYRAMID_LEVELS = 4;
const RANDOM_SEARCH_RATIO = 0.5;

/**
 * Check if an RGBA pixel looks like skin.
 * Filters out clothing, background, hair, etc.
 */
function isSkinPixelRGBA(pixels, idx) {
  const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
  const brightness = r * 0.299 + g * 0.587 + b * 0.114;
  if (brightness < 25) return false;  // too dark (clothing, hair, deep shadows)
  if (brightness > 240 && (r - b) < 10) return false; // white/cool highlights
  if (b > r + 30) return false; // blue
  if (g > r + 30) return false; // green
  // Skin: R > G > B typically
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return false;
  const sat = (max - min) / max;
  let hue = 0;
  const delta = max - min;
  if (delta > 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
    if (hue < 0) hue += 360;
  }
  if (hue > 55 && hue < 320) return false; // non-skin hue
  if (sat > 0.8) return false; // too saturated
  return true;
}

/**
 * Convert RGB to LAB color space for perceptual matching.
 * Returns [L, a, b] in typical ranges: L[0-100], a[-128,127], b[-128,127]
 */
function rgbToLab(r, g, b) {
  // Normalize to 0-1
  let lr = r / 255, lg = g / 255, lb = b / 255;

  // sRGB to linear
  lr = lr > 0.04045 ? Math.pow((lr + 0.055) / 1.055, 2.4) : lr / 12.92;
  lg = lg > 0.04045 ? Math.pow((lg + 0.055) / 1.055, 2.4) : lg / 12.92;
  lb = lb > 0.04045 ? Math.pow((lb + 0.055) / 1.055, 2.4) : lb / 12.92;

  // Linear RGB to XYZ (D65)
  let x = lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375;
  let y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750;
  let z = lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041;

  // XYZ to Lab
  x /= 0.95047; y /= 1.0; z /= 1.08883;
  x = x > 0.008856 ? Math.cbrt(x) : 7.787 * x + 16 / 116;
  y = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116;
  z = z > 0.008856 ? Math.cbrt(z) : 7.787 * z + 16 / 116;

  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/**
 * Build a LAB image from RGBA pixel data.
 */
function buildLabImage(pixels, width, height) {
  const lab = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const pi = i * 4;
    const [l, a, b] = rgbToLab(pixels[pi], pixels[pi + 1], pixels[pi + 2]);
    lab[i * 3] = l;
    lab[i * 3 + 1] = a;
    lab[i * 3 + 2] = b;
  }
  return lab;
}

/**
 * Downsample an image by 2x using area averaging.
 */
function downsample(pixels, width, height) {
  const nw = Math.floor(width / 2);
  const nh = Math.floor(height / 2);
  const out = new Uint8Array(nw * nh * 4);

  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const di = (y * nw + x) * 4;
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const si = ((y * 2 + dy) * width + (x * 2 + dx)) * 4;
          r += pixels[si]; g += pixels[si + 1]; b += pixels[si + 2]; a += pixels[si + 3];
        }
      }
      out[di] = r >> 2; out[di + 1] = g >> 2; out[di + 2] = b >> 2; out[di + 3] = a >> 2;
    }
  }
  return { pixels: out, width: nw, height: nh };
}

/**
 * Downsample a binary mask by 2x (any source pixel set = target set).
 */
function downsampleMask(mask, width, height) {
  const nw = Math.floor(width / 2);
  const nh = Math.floor(height / 2);
  const out = new Uint8Array(nw * nh);

  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      if (mask[(y * 2) * width + (x * 2)] ||
          mask[(y * 2) * width + (x * 2 + 1)] ||
          mask[(y * 2 + 1) * width + (x * 2)] ||
          mask[(y * 2 + 1) * width + (x * 2 + 1)]) {
        out[y * nw + x] = 1;
      }
    }
  }
  return { mask: out, width: nw, height: nh };
}

/**
 * Compute patch distance in LAB space between two patch centers.
 * Only compares known (unmasked) pixels.
 */
function patchDistance(lab, mask, w, h, ax, ay, bx, by) {
  let dist = 0;
  let count = 0;

  for (let dy = -HALF_PATCH; dy <= HALF_PATCH; dy++) {
    for (let dx = -HALF_PATCH; dx <= HALF_PATCH; dx++) {
      const px = ax + dx, py = ay + dy;
      const qx = bx + dx, qy = by + dy;

      // Bounds check
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;

      // Source patch pixel must not be masked
      if (mask[qy * w + qx]) continue;

      const pi = (py * w + px) * 3;
      const qi = (qy * w + qx) * 3;

      const dl = lab[pi] - lab[qi];
      const da = lab[pi + 1] - lab[qi + 1];
      const db = lab[pi + 2] - lab[qi + 2];
      dist += dl * dl + da * da + db * db;
      count++;
    }
  }

  return count > 0 ? dist / count : Infinity;
}

/**
 * Simple PRNG for deterministic randomization.
 */
function createRng(seed) {
  let s = seed;
  return function() {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/**
 * Core PatchMatch at a single pyramid level.
 *
 * @param {Uint8Array} pixels - RGBA pixel data (modified in place for masked regions)
 * @param {Uint8Array} mask - Binary mask (1 = to inpaint)
 * @param {number} width
 * @param {number} height
 */
function patchMatchLevel(pixels, mask, width, height) {
  const lab = buildLabImage(pixels, width, height);
  const rng = createRng(42);

  // Collect source (unmasked, skin-only) pixel positions for random sampling
  const sourcePositions = [];
  const allSourcePositions = [];
  for (let y = HALF_PATCH; y < height - HALF_PATCH; y++) {
    for (let x = HALF_PATCH; x < width - HALF_PATCH; x++) {
      if (!mask[y * width + x]) {
        allSourcePositions.push([x, y]);
        // Only use skin pixels as sources for better inpainting
        if (isSkinPixelRGBA(pixels, (y * width + x) * 4)) {
          sourcePositions.push([x, y]);
        }
      }
    }
  }

  console.log(`[PatchMatch] Source positions: ${sourcePositions.length} skin / ${allSourcePositions.length} total`);

  // Fall back to all sources if too few skin pixels found
  const effectiveSources = sourcePositions.length > 50 ? sourcePositions : allSourcePositions;
  if (effectiveSources.length === 0) return;

  // NNF: for each masked pixel, store the best matching source position
  const nnfX = new Int32Array(width * height);
  const nnfY = new Int32Array(width * height);
  const nnfDist = new Float32Array(width * height);
  nnfDist.fill(Infinity);

  // Initialize NNF randomly for masked pixels
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      const src = effectiveSources[Math.floor(rng() * effectiveSources.length)];
      nnfX[y * width + x] = src[0];
      nnfY[y * width + x] = src[1];
      nnfDist[y * width + x] = patchDistance(lab, mask, width, height, x, y, src[0], src[1]);
    }
  }

  // Iterate: propagation + random search
  for (let iter = 0; iter < NUM_ITERATIONS; iter++) {
    const forward = iter % 2 === 0;
    const yStart = forward ? 0 : height - 1;
    const yEnd = forward ? height : -1;
    const yStep = forward ? 1 : -1;
    const xStart = forward ? 0 : width - 1;
    const xEnd = forward ? width : -1;
    const xStep = forward ? 1 : -1;

    for (let y = yStart; y !== yEnd; y += yStep) {
      for (let x = xStart; x !== xEnd; x += xStep) {
        if (!mask[y * width + x]) continue;
        const idx = y * width + x;

        // Propagation: try neighbor's offset
        const neighbors = forward
          ? [[x - 1, y], [x, y - 1]]
          : [[x + 1, y], [x, y + 1]];

        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nidx = ny * width + nx;
          if (nnfDist[nidx] === Infinity) continue;

          // Try the same source offset as the neighbor
          const candX = nnfX[nidx] + (x - nx);
          const candY = nnfY[nidx] + (y - ny);

          if (candX < HALF_PATCH || candY < HALF_PATCH ||
              candX >= width - HALF_PATCH || candY >= height - HALF_PATCH) continue;
          if (mask[candY * width + candX]) continue;

          const d = patchDistance(lab, mask, width, height, x, y, candX, candY);
          if (d < nnfDist[idx]) {
            nnfX[idx] = candX;
            nnfY[idx] = candY;
            nnfDist[idx] = d;
          }
        }

        // Random search: try random positions at decreasing radii
        let searchRadius = Math.max(width, height) * RANDOM_SEARCH_RATIO;
        while (searchRadius >= 1) {
          const candX = Math.max(HALF_PATCH, Math.min(width - HALF_PATCH - 1,
            Math.round(nnfX[idx] + (rng() * 2 - 1) * searchRadius)));
          const candY = Math.max(HALF_PATCH, Math.min(height - HALF_PATCH - 1,
            Math.round(nnfY[idx] + (rng() * 2 - 1) * searchRadius)));

          if (!mask[candY * width + candX]) {
            const d = patchDistance(lab, mask, width, height, x, y, candX, candY);
            if (d < nnfDist[idx]) {
              nnfX[idx] = candX;
              nnfY[idx] = candY;
              nnfDist[idx] = d;
            }
          }
          searchRadius *= 0.5;
        }
      }
    }

    // After each iteration, fill masked pixels using weighted patch voting.
    // Instead of copying from a single best-match pixel, average contributions
    // from neighboring NNF entries whose patches overlap this pixel.
    // This eliminates visible discontinuities between adjacent patch matches.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!mask[y * width + x]) continue;
        const idx = y * width + x;
        if (nnfDist[idx] === Infinity) continue;

        let sumR = 0, sumG = 0, sumB = 0, sumW = 0;
        const voteNeighbors = [[0,0], [-1,0], [1,0], [0,-1], [0,1],
                               [-1,-1], [1,-1], [-1,1], [1,1]];

        for (const [dx, dy] of voteNeighbors) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nidx = ny * width + nx;
          if (nnfDist[nidx] === Infinity) continue;

          // Neighbor's NNF maps (nx,ny) → (nnfX[nidx], nnfY[nidx]).
          // The pixel at our position (x,y) corresponds to source offset (-dx,-dy).
          const sx = nnfX[nidx] - dx;
          const sy = nnfY[nidx] - dy;
          if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
          if (mask[sy * width + sx]) continue; // source must be unmasked

          const si = (sy * width + sx) * 4;
          const w = 1 / (1 + nnfDist[nidx]);
          sumR += pixels[si] * w;
          sumG += pixels[si + 1] * w;
          sumB += pixels[si + 2] * w;
          sumW += w;
        }

        const di = (y * width + x) * 4;
        if (sumW > 0) {
          pixels[di] = Math.round(sumR / sumW);
          pixels[di + 1] = Math.round(sumG / sumW);
          pixels[di + 2] = Math.round(sumB / sumW);
        } else {
          // Fallback: direct NNF copy
          const sx = nnfX[idx], sy = nnfY[idx];
          const si = (sy * width + sx) * 4;
          pixels[di] = pixels[si];
          pixels[di + 1] = pixels[si + 1];
          pixels[di + 2] = pixels[si + 2];
        }

        const [l, a, b] = rgbToLab(pixels[di], pixels[di + 1], pixels[di + 2]);
        lab[idx * 3] = l;
        lab[idx * 3 + 1] = a;
        lab[idx * 3 + 2] = b;
      }
    }
  }
}

/**
 * Main PatchMatch inpainting function.
 *
 * @param {Uint8Array} pixels - RGBA pixel data (will be modified in place)
 * @param {Uint8Array} mask - Binary mask same size as image (1 = inpaint, 0 = keep)
 * @param {number} width
 * @param {number} height
 */
export function patchMatchInpaint(pixels, mask, width, height) {
  console.log('[PatchMatch] Starting inpainting...');
  const t0 = performance.now();

  // Build image pyramid
  const pyramid = [{ pixels: new Uint8Array(pixels), mask: new Uint8Array(mask), width, height }];

  let curPixels = pixels;
  let curMask = mask;
  let curW = width;
  let curH = height;

  for (let level = 1; level < NUM_PYRAMID_LEVELS; level++) {
    const ds = downsample(curPixels, curW, curH);
    const dm = downsampleMask(curMask, curW, curH);
    pyramid.push({ pixels: ds.pixels, mask: dm.mask, width: ds.width, height: ds.height });
    curPixels = ds.pixels;
    curMask = dm.mask;
    curW = ds.width;
    curH = ds.height;
  }

  // Process coarsest to finest
  for (let level = pyramid.length - 1; level >= 0; level--) {
    const { pixels: lvlPx, mask: lvlMask, width: lvlW, height: lvlH } = pyramid[level];

    console.log(`[PatchMatch] Level ${level}: ${lvlW}x${lvlH}`);
    patchMatchLevel(lvlPx, lvlMask, lvlW, lvlH);

    // If not at finest level, upsample results to initialize next level
    if (level > 0) {
      const finer = pyramid[level - 1];
      for (let y = 0; y < finer.height; y++) {
        for (let x = 0; x < finer.width; x++) {
          if (!finer.mask[y * finer.width + x]) continue;

          // Sample from coarser level
          const cx = Math.min(lvlW - 1, Math.floor(x / 2));
          const cy = Math.min(lvlH - 1, Math.floor(y / 2));
          const si = (cy * lvlW + cx) * 4;
          const di = (y * finer.width + x) * 4;
          finer.pixels[di] = lvlPx[si];
          finer.pixels[di + 1] = lvlPx[si + 1];
          finer.pixels[di + 2] = lvlPx[si + 2];
        }
      }
    }
  }

  // Copy finest level results back to input
  const finest = pyramid[0];
  for (let i = 0; i < width * height; i++) {
    if (!mask[i]) continue;
    const di = i * 4;
    pixels[di] = finest.pixels[di];
    pixels[di + 1] = finest.pixels[di + 1];
    pixels[di + 2] = finest.pixels[di + 2];
  }

  console.log(`[PatchMatch] Done in ${(performance.now() - t0).toFixed(0)}ms`);
}
