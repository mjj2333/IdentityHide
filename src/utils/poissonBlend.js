/**
 * Poisson blending for seamless compositing at mask boundaries.
 *
 * Solves the discrete Poisson equation (Laplacian) over the masked region
 * to match gradients from the inpainted interior while anchoring boundary
 * pixels to the original image. This eliminates visible seams.
 *
 * Uses Gauss-Seidel iterative solver with SOR (successive over-relaxation).
 */

const NUM_ITERATIONS = 200;
const SOR_OMEGA = 1.6; // Over-relaxation factor (1.0 = standard GS, 1.5-1.9 = SOR)
const CONVERGENCE_THRESHOLD = 0.05;

/**
 * Build a boundary map: pixels where mask transitions from 1→0
 * These pixels are fixed (Dirichlet boundary conditions).
 */
function buildBoundaryMap(mask, width, height) {
  const boundary = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (mask[y * width + x]) continue; // interior masked pixel
      // Check if any neighbor is masked
      if (mask[(y - 1) * width + x] || mask[(y + 1) * width + x] ||
          mask[y * width + (x - 1)] || mask[y * width + (x + 1)]) {
        boundary[y * width + x] = 1;
      }
    }
  }
  return boundary;
}

/**
 * Poisson blend: seamlessly merge inpainted pixels with the original.
 *
 * @param {Uint8Array} origPixels - Original RGBA pixels (boundary reference)
 * @param {Uint8Array} filledPixels - PatchMatch-filled RGBA pixels (gradient source)
 * @param {Uint8Array} mask - Binary mask (1 = inpainted region)
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} outputPixels - Output RGBA pixels (modified in place)
 */
export function poissonBlend(origPixels, filledPixels, mask, width, height, outputPixels) {
  console.log('[Poisson] Starting blending...');
  const t0 = performance.now();

  // Copy original to output as base
  outputPixels.set(origPixels);

  // Count masked pixels
  let maskedCount = 0;
  for (let i = 0; i < width * height; i++) {
    if (mask[i]) maskedCount++;
  }
  if (maskedCount === 0) return;

  // Process each channel independently
  for (let c = 0; c < 3; c++) {
    // Extract single-channel data as float
    const solution = new Float32Array(width * height);
    const guidance = new Float32Array(width * height);

    // Initialize: masked pixels from filled, unmasked from original
    for (let i = 0; i < width * height; i++) {
      const pi = i * 4 + c;
      solution[i] = mask[i] ? filledPixels[pi] : origPixels[pi];
      guidance[i] = filledPixels[pi];
    }

    // Compute guidance field (Laplacian of filled image within mask)
    // This preserves the gradients/texture from PatchMatch
    const laplacian = new Float32Array(width * height);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        if (!mask[y * width + x]) continue;
        const idx = y * width + x;
        laplacian[idx] =
          4 * guidance[idx] -
          guidance[(y - 1) * width + x] -
          guidance[(y + 1) * width + x] -
          guidance[y * width + (x - 1)] -
          guidance[y * width + (x + 1)];
      }
    }

    // Gauss-Seidel with SOR
    for (let iter = 0; iter < NUM_ITERATIONS; iter++) {
      let maxDelta = 0;

      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          if (!mask[y * width + x]) continue;
          const idx = y * width + x;

          // Solve: Δf = Δg (match Laplacian of guidance)
          const neighborSum =
            solution[(y - 1) * width + x] +
            solution[(y + 1) * width + x] +
            solution[y * width + (x - 1)] +
            solution[y * width + (x + 1)];

          const newVal = (neighborSum - laplacian[idx]) / 4;
          const delta = Math.abs(newVal - solution[idx]);
          maxDelta = Math.max(maxDelta, delta);

          // SOR update
          solution[idx] = solution[idx] + SOR_OMEGA * (newVal - solution[idx]);
        }
      }

      // Early termination if converged
      if (maxDelta < CONVERGENCE_THRESHOLD) {
        if (c === 0) console.log(`[Poisson] Channel ${c} converged at iteration ${iter}`);
        break;
      }
    }

    // Write solution back to output
    for (let i = 0; i < width * height; i++) {
      if (!mask[i]) continue;
      outputPixels[i * 4 + c] = Math.max(0, Math.min(255, Math.round(solution[i])));
    }
  }

  console.log(`[Poisson] Done in ${(performance.now() - t0).toFixed(0)}ms`);
}

/**
 * Convenience wrapper: Poisson blend within a bounding box for performance.
 * Only solves the equation in the bbox region + margin, not the full image.
 */
export function poissonBlendRegion(origPixels, filledPixels, mask, imgWidth, imgHeight, bbox) {
  const margin = PATCH_SIZE || 10;
  const x0 = Math.max(0, bbox.x - margin);
  const y0 = Math.max(0, bbox.y - margin);
  const x1 = Math.min(imgWidth, bbox.x + bbox.w + margin);
  const y1 = Math.min(imgHeight, bbox.y + bbox.h + margin);
  const rw = x1 - x0;
  const rh = y1 - y0;

  // Extract region
  const regionOrig = new Uint8Array(rw * rh * 4);
  const regionFilled = new Uint8Array(rw * rh * 4);
  const regionMask = new Uint8Array(rw * rh);
  const regionOutput = new Uint8Array(rw * rh * 4);

  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const srcIdx = ((y0 + y) * imgWidth + (x0 + x));
      const dstIdx = y * rw + x;
      const si = srcIdx * 4;
      const di = dstIdx * 4;
      regionOrig[di] = origPixels[si];
      regionOrig[di + 1] = origPixels[si + 1];
      regionOrig[di + 2] = origPixels[si + 2];
      regionOrig[di + 3] = origPixels[si + 3];
      regionFilled[di] = filledPixels[si];
      regionFilled[di + 1] = filledPixels[si + 1];
      regionFilled[di + 2] = filledPixels[si + 2];
      regionFilled[di + 3] = filledPixels[si + 3];
      regionMask[dstIdx] = mask[srcIdx];
    }
  }

  poissonBlend(regionOrig, regionFilled, regionMask, rw, rh, regionOutput);

  // Write region output back to full-size output
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const srcIdx = y * rw + x;
      if (!regionMask[srcIdx]) continue;
      const dstIdx = ((y0 + y) * imgWidth + (x0 + x)) * 4;
      const si = srcIdx * 4;
      filledPixels[dstIdx] = regionOutput[si];
      filledPixels[dstIdx + 1] = regionOutput[si + 1];
      filledPixels[dstIdx + 2] = regionOutput[si + 2];
    }
  }
}

const PATCH_SIZE_CONST = 7;
