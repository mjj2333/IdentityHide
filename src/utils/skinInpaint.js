/**
 * Skin inpainting engine for tattoo removal.
 * Replaces tattoo pixels with synthesized skin that matches
 * the surrounding tone, lighting gradient, and texture.
 */

/**
 * Check if a pixel looks like skin using HSV heuristics.
 * Filters out clothing, background, hair, etc.
 */
function isSkinPixel(r, g, b) {
  // Very dark pixels (clothing, hair, shadows) — reject
  const brightness = r * 0.299 + g * 0.587 + b * 0.114;
  if (brightness < 40) return false;

  // Very bright/white pixels (highlights, sky) — allow if warm-toned
  if (brightness > 240 && (r - b) < 10) return false;

  // Skin in RGB: R > G > B typically, or R > B at minimum
  // Very blue or very green pixels are not skin
  if (b > r + 30) return false;
  if (g > r + 30) return false;

  // HSV-based skin detection
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  if (max === 0) return false;

  const saturation = delta / max;
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
    if (hue < 0) hue += 360;
  }

  // Skin hue is typically 0-50 (red-orange-yellow range)
  // Allow wider range for diverse skin tones
  if (hue > 55 && hue < 320) return false;

  // Very saturated pure colors are not skin
  if (saturation > 0.8) return false;

  return true;
}

/**
 * Sample unmasked skin pixels from a border ring around the tattoo region.
 * Uses BodyPix segmentation and skin-tone heuristics to filter non-skin pixels.
 */
function sampleBorderSkin(srcPixels, maskPixels, bbox, imgWidth, imgHeight, segData) {
  const { x, y, w, h } = bbox;
  const samples = [];
  const margin = Math.max(6, Math.round(Math.min(w, h) * 0.2));

  // Expand the sampling region beyond the bbox
  const left = Math.max(0, x - margin);
  const top = Math.max(0, y - margin);
  const right = Math.min(imgWidth, x + w + margin);
  const bot = Math.min(imgHeight, y + h + margin);

  const hasSeg = segData && segData.data;
  const segW = hasSeg ? segData.width : 0;
  const segH = hasSeg ? segData.height : 0;
  const segScaleX = hasSeg ? segW / imgWidth : 0;
  const segScaleY = hasSeg ? segH / imgHeight : 0;

  for (let py = top; py < bot; py++) {
    for (let px = left; px < right; px++) {
      const mi = (py * imgWidth + px) * 4;
      // Only sample unmasked pixels (mask alpha < 64)
      if (maskPixels[mi + 3] >= 64) continue;

      // Only sample pixels in the border ring (not deep inside bbox)
      const inBox = px >= x && px < x + w && py >= y && py < y + h;
      const inMargin = !inBox || (
        px < x + margin || px >= x + w - margin ||
        py < y + margin || py >= y + h - margin
      );
      if (!inMargin) continue;

      const r = srcPixels[mi];
      const g = srcPixels[mi + 1];
      const b = srcPixels[mi + 2];

      // Filter 1: BodyPix segmentation — must be a person pixel
      if (hasSeg) {
        const segX = Math.floor(px * segScaleX);
        const segY = Math.floor(py * segScaleY);
        const partId = segData.data[segY * segW + segX];
        if (partId < 0) continue; // not a person pixel
      }

      // Filter 2: Skin tone heuristic
      if (!isSkinPixel(r, g, b)) continue;

      samples.push({ x: px, y: py, r, g, b });
    }
  }

  return samples;
}

/**
 * Cluster border samples into angular sectors around the mask centroid
 * for efficient IDW interpolation.
 */
function clusterBorderSamples(samples, cx, cy, numSectors = 24) {
  if (samples.length === 0) return [];

  const sectors = Array.from({ length: numSectors }, () => ({
    x: 0, y: 0, r: 0, g: 0, b: 0, count: 0
  }));

  for (const s of samples) {
    let angle = Math.atan2(s.y - cy, s.x - cx);
    if (angle < 0) angle += Math.PI * 2;
    const idx = Math.min(numSectors - 1, Math.floor(angle / (Math.PI * 2) * numSectors));
    sectors[idx].x += s.x;
    sectors[idx].y += s.y;
    sectors[idx].r += s.r;
    sectors[idx].g += s.g;
    sectors[idx].b += s.b;
    sectors[idx].count++;
  }

  const result = [];
  for (const sec of sectors) {
    if (sec.count === 0) continue;
    result.push({
      x: sec.x / sec.count,
      y: sec.y / sec.count,
      r: sec.r / sec.count,
      g: sec.g / sec.count,
      b: sec.b / sec.count,
    });
  }

  // If too few sectors filled, also add individual samples for coverage
  if (result.length < 6 && samples.length > 0) {
    // Add evenly spaced individual samples
    const step = Math.max(1, Math.floor(samples.length / 12));
    for (let i = 0; i < samples.length; i += step) {
      result.push(samples[i]);
    }
  }

  return result;
}

/**
 * Build a smooth tone field using inverse-distance-weighted interpolation.
 * Computed at reduced resolution and upsampled for performance.
 */
function interpolateToneField(clusters, bbox, subsample = 4) {
  const { x, y, w, h } = bbox;
  const sw = Math.ceil(w / subsample);
  const sh = Math.ceil(h / subsample);
  const field = new Float32Array(sw * sh * 3);

  if (clusters.length === 0) return { field, sw, sh };

  const power = 2;
  const epsilon = 1;

  for (let sy = 0; sy < sh; sy++) {
    for (let sx = 0; sx < sw; sx++) {
      const px = x + sx * subsample + subsample / 2;
      const py = y + sy * subsample + subsample / 2;

      let sumR = 0, sumG = 0, sumB = 0, sumW = 0;

      for (const c of clusters) {
        const dx = px - c.x;
        const dy = py - c.y;
        const dist2 = dx * dx + dy * dy;
        const wt = 1 / (Math.pow(dist2, power / 2) + epsilon);
        sumR += wt * c.r;
        sumG += wt * c.g;
        sumB += wt * c.b;
        sumW += wt;
      }

      const fi = (sy * sw + sx) * 3;
      field[fi] = sumR / sumW;
      field[fi + 1] = sumG / sumW;
      field[fi + 2] = sumB / sumW;
    }
  }

  return { field, sw, sh };
}

/**
 * Bilinear upsample the tone field to full resolution.
 */
function upsampleToneField(field, sw, sh, w, h, subsample) {
  const result = new Float32Array(w * h * 3);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) / subsample - 0.5;
      const fy = (y + 0.5) / subsample - 0.5;

      const x0 = Math.max(0, Math.floor(fx));
      const y0 = Math.max(0, Math.floor(fy));
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);

      const tx = Math.max(0, Math.min(1, fx - x0));
      const ty = Math.max(0, Math.min(1, fy - y0));

      for (let c = 0; c < 3; c++) {
        const v00 = field[(y0 * sw + x0) * 3 + c];
        const v10 = field[(y0 * sw + x1) * 3 + c];
        const v01 = field[(y1 * sw + x0) * 3 + c];
        const v11 = field[(y1 * sw + x1) * 3 + c];

        result[(y * w + x) * 3 + c] =
          v00 * (1 - tx) * (1 - ty) +
          v10 * tx * (1 - ty) +
          v01 * (1 - tx) * ty +
          v11 * tx * ty;
      }
    }
  }

  return result;
}

/**
 * Extract high-frequency texture from unmasked skin only.
 * Returns the difference between original and locally-blurred values.
 */
function extractTextureResidual(srcPixels, maskPixels, bbox, imgWidth, imgHeight, segData) {
  const { x, y, w, h } = bbox;
  const blurR = 4;
  const residual = new Float32Array(w * h * 3);
  const hasResidual = new Uint8Array(w * h);

  const hasSeg = segData && segData.data;
  const segW = hasSeg ? segData.width : 0;
  const segH = hasSeg ? segData.height : 0;
  const segScaleX = hasSeg ? segW / imgWidth : 0;
  const segScaleY = hasSeg ? segH / imgHeight : 0;

  for (let ly = 0; ly < h; ly++) {
    for (let lx = 0; lx < w; lx++) {
      const gx = x + lx;
      const gy = y + ly;
      const mi = (gy * imgWidth + gx) * 4;

      // Only extract texture from unmasked skin pixels
      if (maskPixels[mi + 3] >= 64) continue;

      const r = srcPixels[mi], g = srcPixels[mi + 1], b = srcPixels[mi + 2];
      if (!isSkinPixel(r, g, b)) continue;

      // Check BodyPix
      if (hasSeg) {
        const segX = Math.floor(gx * segScaleX);
        const segY = Math.floor(gy * segScaleY);
        if (segData.data[segY * segW + segX] < 0) continue;
      }

      // Local average (box blur) from skin-only neighbors
      let sumR = 0, sumG = 0, sumB = 0, count = 0;
      for (let dy = -blurR; dy <= blurR; dy++) {
        for (let dx = -blurR; dx <= blurR; dx++) {
          const nx = gx + dx;
          const ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= imgWidth || ny >= imgHeight) continue;
          const ni = (ny * imgWidth + nx) * 4;
          if (maskPixels[ni + 3] >= 64) continue;
          if (!isSkinPixel(srcPixels[ni], srcPixels[ni + 1], srcPixels[ni + 2])) continue;
          sumR += srcPixels[ni];
          sumG += srcPixels[ni + 1];
          sumB += srcPixels[ni + 2];
          count++;
        }
      }

      if (count < 3) continue;

      const ri = (ly * w + lx) * 3;
      residual[ri] = r - sumR / count;
      residual[ri + 1] = g - sumG / count;
      residual[ri + 2] = b - sumB / count;
      hasResidual[ly * w + lx] = 1;
    }
  }

  return { residual, hasResidual };
}

/**
 * Synthesize texture for masked pixels by sampling from nearest unmasked skin.
 * Uses small random jitter to prevent repetitive patterns.
 */
function synthesizeTexture(residual, hasResidual, maskPixels, bbox, imgWidth, w, h) {
  const { x, y } = bbox;
  const synthResidual = new Float32Array(w * h * 3);

  // Simple seeded PRNG for deterministic jitter
  let seed = 12345;
  function rand() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  }

  // Build a list of valid texture source positions
  const sources = [];
  for (let ly = 0; ly < h; ly++) {
    for (let lx = 0; lx < w; lx++) {
      if (hasResidual[ly * w + lx]) {
        sources.push({ lx, ly });
      }
    }
  }

  if (sources.length === 0) return synthResidual;

  // Build a spatial grid for faster nearest-source lookup
  const gridSize = Math.max(8, Math.round(Math.sqrt(Math.max(w, h))));
  const gridCellW = w / gridSize;
  const gridCellH = h / gridSize;
  const grid = Array.from({ length: gridSize * gridSize }, () => []);
  for (let si = 0; si < sources.length; si++) {
    const s = sources[si];
    const gx = Math.min(gridSize - 1, Math.floor(s.lx / gridCellW));
    const gy = Math.min(gridSize - 1, Math.floor(s.ly / gridCellH));
    grid[gy * gridSize + gx].push(si);
  }

  for (let ly = 0; ly < h; ly++) {
    for (let lx = 0; lx < w; lx++) {
      const gxp = x + lx;
      const gyp = y + ly;
      const mi = (gyp * imgWidth + gxp) * 4;

      if (maskPixels[mi + 3] < 64) {
        // Unmasked: use original residual
        const ri = (ly * w + lx) * 3;
        synthResidual[ri] = residual[ri];
        synthResidual[ri + 1] = residual[ri + 1];
        synthResidual[ri + 2] = residual[ri + 2];
        continue;
      }

      // Find nearest valid source using grid
      const gcx = Math.min(gridSize - 1, Math.floor(lx / gridCellW));
      const gcy = Math.min(gridSize - 1, Math.floor(ly / gridCellH));
      let bestDist = Infinity;
      let bestSrc = sources[0];

      // Search expanding rings around the grid cell
      for (let radius = 0; radius < gridSize && bestDist > (radius - 1) * (radius - 1) * gridCellW * gridCellH; radius++) {
        for (let gdy = Math.max(0, gcy - radius); gdy <= Math.min(gridSize - 1, gcy + radius); gdy++) {
          for (let gdx = Math.max(0, gcx - radius); gdx <= Math.min(gridSize - 1, gcx + radius); gdx++) {
            if (radius > 0 && Math.abs(gdx - gcx) < radius && Math.abs(gdy - gcy) < radius) continue;
            const cell = grid[gdy * gridSize + gdx];
            for (const si of cell) {
              const s = sources[si];
              const dx = lx - s.lx;
              const dy = ly - s.ly;
              const d = dx * dx + dy * dy;
              if (d < bestDist) {
                bestDist = d;
                bestSrc = s;
              }
            }
          }
        }
      }

      const sri = (bestSrc.ly * w + bestSrc.lx) * 3;
      const dri = (ly * w + lx) * 3;

      // Slight random variation to avoid repetition
      const scale = 0.8 + Math.abs(rand()) * 0.4;
      synthResidual[dri] = residual[sri] * scale;
      synthResidual[dri + 1] = residual[sri + 1] * scale;
      synthResidual[dri + 2] = residual[sri + 2] * scale;
    }
  }

  return synthResidual;
}

/**
 * Jacobi smoothing iterations to reduce seams at mask boundaries.
 */
function gradientSmooth(outputPixels, maskPixels, bbox, imgWidth, iterations = 8) {
  const { x, y, w, h } = bbox;
  const blend = 0.4;

  for (let iter = 0; iter < iterations; iter++) {
    for (let ly = 1; ly < h - 1; ly++) {
      for (let lx = 1; lx < w - 1; lx++) {
        const gx = x + lx;
        const gy = y + ly;
        const mi = (gy * imgWidth + gx) * 4;

        if (maskPixels[mi + 3] < 64) continue;

        const ci = mi;
        const li = (gy * imgWidth + (gx - 1)) * 4;
        const ri = (gy * imgWidth + (gx + 1)) * 4;
        const ti = ((gy - 1) * imgWidth + gx) * 4;
        const bi = ((gy + 1) * imgWidth + gx) * 4;

        for (let c = 0; c < 3; c++) {
          const avg = (outputPixels[li + c] + outputPixels[ri + c] +
                       outputPixels[ti + c] + outputPixels[bi + c]) / 4;
          outputPixels[ci + c] = Math.round(
            outputPixels[ci + c] * (1 - blend) + avg * blend
          );
        }
      }
    }
  }
}

/**
 * Main inpainting function.
 * Replaces tattoo-masked pixels with synthesized skin.
 */
export function applySkinInpaint(sourceCanvas, maskCanvas, detections, toggles) {
  const { width, height } = sourceCanvas;
  const outCanvas = document.createElement('canvas');
  outCanvas.width = width;
  outCanvas.height = height;
  const outCtx = outCanvas.getContext('2d');

  outCtx.drawImage(sourceCanvas, 0, 0);

  const srcCtx = sourceCanvas.getContext('2d');
  const srcData = srcCtx.getImageData(0, 0, width, height);
  const srcPixels = srcData.data;

  const maskCtx = maskCanvas.getContext('2d');
  const maskData = maskCtx.getImageData(0, 0, width, height);
  const maskPixels = maskData.data;

  const outData = outCtx.getImageData(0, 0, width, height);
  const outPixels = outData.data;

  const subsample = 3;

  detections.forEach((det, i) => {
    if (toggles && toggles[i] === false) return;
    if (det.type !== 'tattoo') return;

    const bboxX = Math.max(0, Math.floor(det.topLeft[0]));
    const bboxY = Math.max(0, Math.floor(det.topLeft[1]));
    const bboxW = Math.min(width - bboxX, Math.ceil(det.bottomRight[0]) - bboxX);
    const bboxH = Math.min(height - bboxY, Math.ceil(det.bottomRight[1]) - bboxY);

    if (bboxW < 4 || bboxH < 4) return;

    const bbox = { x: bboxX, y: bboxY, w: bboxW, h: bboxH };

    // Get segmentation data for skin filtering
    const segData = det.segData || null;

    // Find mask centroid
    let cxSum = 0, cySum = 0, cCount = 0;
    for (let ly = 0; ly < bboxH; ly++) {
      for (let lx = 0; lx < bboxW; lx++) {
        const mi = ((bboxY + ly) * width + (bboxX + lx)) * 4;
        if (maskPixels[mi + 3] >= 64) {
          cxSum += bboxX + lx;
          cySum += bboxY + ly;
          cCount++;
        }
      }
    }

    if (cCount === 0) {
      console.log(`[INPAINT DEBUG] Tattoo ${i}: NO masked pixels found in bbox! Skipping.`);
      return;
    }

    const cx = cxSum / cCount;
    const cy = cySum / cCount;
    console.log(`[INPAINT DEBUG] Tattoo ${i}: ${cCount} masked pixels in bbox ${bboxX},${bboxY} ${bboxW}x${bboxH}`);

    // Step 1: Sample border skin (filtered by segmentation + skin heuristic)
    const borderSamples = sampleBorderSkin(srcPixels, maskPixels, bbox, width, height, segData);
    console.log(`[INPAINT DEBUG] Tattoo ${i}: ${borderSamples.length} border skin samples`);

    if (borderSamples.length < 3) {
      console.log(`[INPAINT DEBUG] Tattoo ${i}: Too few border samples (${borderSamples.length}), using fallback`);
      // Not enough skin context — fall back to simple average fill
      let avgR = 0, avgG = 0, avgB = 0;
      if (borderSamples.length > 0) {
        for (const s of borderSamples) { avgR += s.r; avgG += s.g; avgB += s.b; }
        avgR /= borderSamples.length;
        avgG /= borderSamples.length;
        avgB /= borderSamples.length;
      } else {
        avgR = 180; avgG = 150; avgB = 130; // generic skin fallback
      }
      for (let ly = 0; ly < bboxH; ly++) {
        for (let lx = 0; lx < bboxW; lx++) {
          const mi = ((bboxY + ly) * width + (bboxX + lx)) * 4;
          const t = maskPixels[mi + 3] / 255;
          if (t < 0.01) continue;
          outPixels[mi] = Math.round(outPixels[mi] * (1 - t) + avgR * t);
          outPixels[mi + 1] = Math.round(outPixels[mi + 1] * (1 - t) + avgG * t);
          outPixels[mi + 2] = Math.round(outPixels[mi + 2] * (1 - t) + avgB * t);
        }
      }
      return;
    }

    // Step 2: Cluster and interpolate tone field
    const clusters = clusterBorderSamples(borderSamples, cx, cy, 24);
    const { field, sw, sh } = interpolateToneField(clusters, bbox, subsample);
    const toneField = upsampleToneField(field, sw, sh, bboxW, bboxH, subsample);

    // Step 3: Extract and synthesize texture
    const { residual, hasResidual } = extractTextureResidual(
      srcPixels, maskPixels, bbox, width, height, segData
    );
    const synthTexture = synthesizeTexture(
      residual, hasResidual, maskPixels, bbox, width, bboxW, bboxH
    );

    // Step 4: Composite — base tone + texture, blended by mask alpha
    for (let ly = 0; ly < bboxH; ly++) {
      for (let lx = 0; lx < bboxW; lx++) {
        const gx = bboxX + lx;
        const gy = bboxY + ly;
        const mi = (gy * width + gx) * 4;
        const maskAlpha = maskPixels[mi + 3];

        if (maskAlpha < 2) continue;

        const ti = (ly * bboxW + lx) * 3;

        // Synthesized skin = tone field + texture residual
        const synthR = Math.max(0, Math.min(255, toneField[ti] + synthTexture[ti]));
        const synthG = Math.max(0, Math.min(255, toneField[ti + 1] + synthTexture[ti + 1]));
        const synthB = Math.max(0, Math.min(255, toneField[ti + 2] + synthTexture[ti + 2]));

        const t = maskAlpha / 255;
        outPixels[mi] = Math.round(outPixels[mi] * (1 - t) + synthR * t);
        outPixels[mi + 1] = Math.round(outPixels[mi + 1] * (1 - t) + synthG * t);
        outPixels[mi + 2] = Math.round(outPixels[mi + 2] * (1 - t) + synthB * t);
      }
    }

    // Step 5: Gradient smoothing to reduce seams
    gradientSmooth(outPixels, maskPixels, bbox, width, 8);
  });

  outCtx.putImageData(outData, 0, 0);
  return outCanvas;
}
