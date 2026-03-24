/**
 * Load a File into a canvas, stripping metadata in the process.
 * The browser applies EXIF orientation when drawing to canvas.
 */
export function fileToCanvas(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };
    img.src = url;
  });
}

/**
 * Promise wrapper around canvas.toBlob
 */
export function canvasToBlob(canvas, format = 'image/png', quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob failed'));
      },
      format,
      quality
    );
  });
}

/**
 * Trigger a file download from a Blob
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Clamp a bounding box to image dimensions
 */
export function clampRect(rect, width, height) {
  return {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    w: Math.min(Math.round(rect.w), width - Math.max(0, Math.round(rect.x))),
    h: Math.min(Math.round(rect.h), height - Math.max(0, Math.round(rect.y))),
  };
}

/**
 * Expand a rect by a percentage factor (e.g., 0.2 = 20% padding)
 */
export function padRect(rect, factor) {
  const padW = rect.w * factor;
  const padH = rect.h * factor;
  return {
    x: rect.x - padW / 2,
    y: rect.y - padH / 2,
    w: rect.w + padW,
    h: rect.h + padH,
  };
}

/**
 * Generate a sanitized export filename
 */
export function generateExportFilename(format = 'png') {
  const ts = Date.now().toString(36);
  return `img_protected_${ts}.${format}`;
}

/**
 * Create a mask canvas using BodyPix part segmentation + face detection.
 * BodyPix gives pixel-level body part IDs — we extract face/head parts
 * within an expanded face region for pixel-accurate masking.
 *
 * BodyPix part IDs:
 *   0 = left_face, 1 = right_face,
 *   plus we include nearby parts for full head coverage
 */
const FACE_PART_IDS = new Set([0, 1]); // left_face, right_face
const HEAD_PART_IDS = new Set([0, 1]); // BodyPix only labels face parts for the head

/**
 * Skin pixel heuristic using HSV-range filtering.
 * Used to constrain tattoo masks to exposed skin areas only.
 */
export function isSkinPixel(r, g, b) {
  const brightness = r * 0.299 + g * 0.587 + b * 0.114;
  if (brightness < 25) return false;
  if (brightness > 240 && (r - b) < 10) return false;
  if (b > r + 40) return false;
  if (g > r + 40) return false;
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
  if (hue > 55 && hue < 320) return false;
  if (sat > 0.8) return false;
  return true;
}

/**
 * Convert RGB to CIELAB for perceptually uniform color distance.
 */
export function rgbToLab(r, g, b) {
  // sRGB to linear
  let rr = r / 255, gg = g / 255, bb = b / 255;
  rr = rr > 0.04045 ? ((rr + 0.055) / 1.055) ** 2.4 : rr / 12.92;
  gg = gg > 0.04045 ? ((gg + 0.055) / 1.055) ** 2.4 : gg / 12.92;
  bb = bb > 0.04045 ? ((bb + 0.055) / 1.055) ** 2.4 : bb / 12.92;
  // Linear RGB to XYZ (D65)
  let x = (rr * 0.4124564 + gg * 0.3575761 + bb * 0.1804375) / 0.95047;
  let y = rr * 0.2126729 + gg * 0.7151522 + bb * 0.0721750;
  let z = (rr * 0.0193339 + gg * 0.1191920 + bb * 0.9503041) / 1.08883;
  const f = t => t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116;
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/**
 * Otsu's method: find optimal threshold that maximizes between-class variance.
 * Returns a threshold clamped to [12, 50] to avoid degenerate cases.
 */
function otsuThreshold(scores) {
  if (scores.length === 0) return 20;
  let maxScore = 0;
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] > maxScore) maxScore = scores[i];
  }
  if (maxScore < 5) return 20;

  const numBins = 128;
  const hist = new Float64Array(numBins);
  for (let i = 0; i < scores.length; i++) {
    const bin = Math.min(numBins - 1, Math.floor(scores[i] / maxScore * (numBins - 1)));
    hist[bin]++;
  }

  const total = scores.length;
  let sumAll = 0;
  for (let i = 0; i < numBins; i++) sumAll += i * hist[i];

  let sumBg = 0, wBg = 0, bestVariance = 0, bestBin = 0;
  for (let i = 0; i < numBins; i++) {
    wBg += hist[i];
    if (wBg === 0) continue;
    const wFg = total - wBg;
    if (wFg === 0) break;
    sumBg += i * hist[i];
    const meanBg = sumBg / wBg;
    const meanFg = (sumAll - sumBg) / wFg;
    const variance = wBg * wFg * (meanBg - meanFg) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestBin = i;
    }
  }

  const threshold = (bestBin / (numBins - 1)) * maxScore;
  return Math.max(12, Math.min(50, threshold));
}

// Debug storage for intermediate masks
window.__maskDebug = window.__maskDebug || {};

/**
 * Debug: create a red overlay showing the mask on top of the source image.
 * Call from console: window.__showMaskOverlay()
 */
window.__showMaskOverlay = function() {
  const debug = window.__maskDebug;
  if (!debug._finalMask || !debug._sourceCanvas) {
    console.log('No debug data yet — process an image first');
    return;
  }
  const src = debug._sourceCanvas;
  const mask = debug._finalMask;
  const overlay = document.createElement('canvas');
  overlay.width = src.width;
  overlay.height = src.height;
  const ctx = overlay.getContext('2d');
  ctx.drawImage(src, 0, 0);

  // Draw mask as semi-transparent red
  const maskCtx = mask.getContext('2d');
  const maskData = maskCtx.getImageData(0, 0, mask.width, mask.height);
  const srcCtx = ctx;
  const imgData = ctx.getImageData(0, 0, overlay.width, overlay.height);
  const d = imgData.data;
  const m = maskData.data;

  for (let idx = 0; idx < d.length; idx += 4) {
    if (m[idx + 3] > 0) {
      const t = m[idx + 3] / 255 * 0.5;
      d[idx] = Math.round(d[idx] * (1 - t) + 255 * t);
      d[idx + 1] = Math.round(d[idx + 1] * (1 - t));
      d[idx + 2] = Math.round(d[idx + 2] * (1 - t));
    }
  }
  ctx.putImageData(imgData, 0, 0);

  // Show it in a new window
  overlay.toBlob(function(blob) {
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'width=' + overlay.width + ',height=' + overlay.height);
  });
  console.log('Mask overlay opened in new window');
};

export function createFaceMask(width, height, detections, toggles, samMasks, options = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);

  detections.forEach((det, i) => {
    if (toggles && toggles[i] === false) return;

    const hasSeg = det.segData && det.segData.data;
    const isTattoo = det.type === 'tattoo';

    if (isTattoo) {
      // Tattoo: pixel-level mask using color/edge analysis within the bounding box
      // We detect tattoo ink by looking for pixels that deviate from surrounding skin tone
      const regionLeft = Math.max(0, Math.floor(det.topLeft[0]));
      const regionTop = Math.max(0, Math.floor(det.topLeft[1]));
      const regionRight = Math.min(width, Math.ceil(det.bottomRight[0]));
      const regionBottom = Math.min(height, Math.ceil(det.bottomRight[1]));
      const rw = regionRight - regionLeft;
      const rh = regionBottom - regionTop;

      if (rw < 2 || rh < 2) return;

      // Read source pixels from a temporary canvas
      const srcCanvas = document.createElement('canvas');
      srcCanvas.width = width;
      srcCanvas.height = height;
      const srcCtx = srcCanvas.getContext('2d');
      // We need access to the source image — draw from the existing canvas context's canvas
      // Since we only have the mask canvas ctx, we'll read from det.sourceCanvas if available
      // Fallback: use the mask canvas dimensions and read from a global ref
      // The source image is passed via det._sourceCanvas (set in the pipeline)
      const sourceRef = det._sourceCanvas;
      if (!sourceRef) {
        // Fallback to bounding box ellipse if no source image available
        const cx = (det.topLeft[0] + det.bottomRight[0]) / 2;
        const cy = (det.topLeft[1] + det.bottomRight[1]) / 2;
        const rx = ((det.bottomRight[0] - det.topLeft[0]) / 2) * 1.05;
        const ry = ((det.bottomRight[1] - det.topLeft[1]) / 2) * 1.05;
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'white';
        ctx.fill();
        ctx.restore();
      } else {
        srcCtx.drawImage(sourceRef, 0, 0);
        const srcData = srcCtx.getImageData(regionLeft, regionTop, rw, rh);
        const sd = srcData.data;

        // Step 0: Build body pixel mask from BodyPix segmentation.
        // ALL subsequent steps operate only on body pixels — background is excluded
        // from the start so wall/sky/furniture textures never contaminate scoring.
        const bodyMask = new Uint8Array(rw * rh);
        let bodyPixelCount = 0;
        if (det.segData && det.segData.data) {
          const { data: partData, width: segW, height: segH } = det.segData;
          const bsx = segW / width;
          const bsy = segH / height;
          for (let y = 0; y < rh; y++) {
            for (let x = 0; x < rw; x++) {
              const segX = Math.floor((regionLeft + x) * bsx);
              const segY = Math.floor((regionTop + y) * bsy);
              if (segX >= 0 && segX < segW && segY >= 0 && segY < segH) {
                if (partData[segY * segW + segX] >= 0) {
                  bodyMask[y * rw + x] = 1;
                  bodyPixelCount++;
                }
              }
            }
          }
          console.log(`[MASK DEBUG] Tattoo ${i}: bbox=${regionLeft},${regionTop} ${rw}x${rh}, body pixels: ${bodyPixelCount}/${rw*rh} (${(bodyPixelCount/(rw*rh)*100).toFixed(0)}%)`);
        } else {
          // No BodyPix data — treat all pixels as potential body
          bodyMask.fill(1);
          bodyPixelCount = rw * rh;
          console.log(`[MASK DEBUG] Tattoo ${i}: bbox=${regionLeft},${regionTop} ${rw}x${rh}, no BodyPix — using all pixels`);
        }

        if (bodyPixelCount < rw * rh * 0.05) {
          console.log(`[MASK DEBUG] Tattoo ${i}: <5% body pixels in bbox, skipping`);
          return;
        }

        // Step 1: Sample border pixels that are ON THE BODY for skin color median
        const allBorderSamples = [];
        const margin = Math.max(2, Math.round(Math.min(rw, rh) * 0.08));
        for (let y = 0; y < rh; y++) {
          for (let x = 0; x < rw; x++) {
            if (!bodyMask[y * rw + x]) continue;
            if (x < margin || x >= rw - margin || y < margin || y >= rh - margin) {
              const pi = (y * rw + x) * 4;
              allBorderSamples.push([sd[pi], sd[pi + 1], sd[pi + 2]]);
            }
          }
        }

        // Filter to skin-only border samples (body pixels that also look like skin)
        const borderSamples = allBorderSamples.filter(s => isSkinPixel(s[0], s[1], s[2]));
        const skinRatio = allBorderSamples.length > 0 ? borderSamples.length / allBorderSamples.length : 0;
        console.log(`[MASK DEBUG] Border (body-only): ${borderSamples.length} skin / ${allBorderSamples.length} body border (${(skinRatio*100).toFixed(0)}%)`);

        // If less than 10% of body border is skin, fallback to all body border pixels
        let medR, medG, medB;
        if (borderSamples.length >= 10) {
          medR = borderSamples.map(s => s[0]).sort((a, b) => a - b)[Math.floor(borderSamples.length / 2)];
          medG = borderSamples.map(s => s[1]).sort((a, b) => a - b)[Math.floor(borderSamples.length / 2)];
          medB = borderSamples.map(s => s[2]).sort((a, b) => a - b)[Math.floor(borderSamples.length / 2)];
        } else if (allBorderSamples.length >= 10) {
          console.log(`[MASK DEBUG] Few skin border pixels, using all body border for median`);
          medR = allBorderSamples.map(s => s[0]).sort((a, b) => a - b)[Math.floor(allBorderSamples.length / 2)];
          medG = allBorderSamples.map(s => s[1]).sort((a, b) => a - b)[Math.floor(allBorderSamples.length / 2)];
          medB = allBorderSamples.map(s => s[2]).sort((a, b) => a - b)[Math.floor(allBorderSamples.length / 2)];
        } else {
          console.log(`[MASK DEBUG] Tattoo ${i}: insufficient body border samples, skipping`);
          return;
        }
        console.log(`[MASK DEBUG] Median skin color: R=${medR} G=${medG} B=${medB}`);

        // Step 2: Simple approach — body pixel + not skin-colored = tattoo.
        // No rays, no chromaticity. YOLO says tattoo is here, so non-skin
        // body pixels within the bbox are overwhelmingly tattoo.
        const medLab = rgbToLab(medR, medG, medB);
        const skinMatchThreshold = options.seedThreshold ?? 15;

        const tattooMask = new Uint8Array(rw * rh);
        let candidateCount = 0;
        for (let y = 0; y < rh; y++) {
          for (let x = 0; x < rw; x++) {
            if (!bodyMask[y * rw + x]) continue;
            const pi = (y * rw + x) * 4;
            const pLab = rgbToLab(sd[pi], sd[pi + 1], sd[pi + 2]);
            const dist = Math.sqrt(
              (pLab[0] - medLab[0]) ** 2 +
              (pLab[1] - medLab[1]) ** 2 +
              (pLab[2] - medLab[2]) ** 2
            );
            if (dist >= skinMatchThreshold) {
              tattooMask[y * rw + x] = 255;
              candidateCount++;
            }
          }
        }
        console.log(`[MASK DEBUG] Non-skin body pixels (LAB>=${skinMatchThreshold}): ${candidateCount}/${bodyPixelCount} (${(candidateCount/bodyPixelCount*100).toFixed(0)}%)`);

        // Step 2b: Expanding radius seed search — BFS distance map from
        // confirmed seeds, then find new seed points within search radius
        // that look like tattoo. Bridges skin-colored gaps between ink
        // regions (e.g., flower interior separated from outline by skin).
        // Iterates so newly found seeds can discover more neighbors.
        const SEED_THRESHOLD = options.searchThreshold ?? 12;
        const MAX_SEARCH_DIST = options.searchDistance ?? 20;
        let totalNewSeeds = 0;
        for (let round = 0; round < 4; round++) {
          const distMap = new Int16Array(rw * rh);
          distMap.fill(-1);
          const distQueue = [];
          for (let k = 0; k < rw * rh; k++) {
            if (tattooMask[k]) { distMap[k] = 0; distQueue.push(k); }
          }
          let dHead = 0;
          while (dHead < distQueue.length) {
            const idx = distQueue[dHead++];
            const d = distMap[idx];
            if (d >= MAX_SEARCH_DIST) continue;
            const dx = idx % rw, dy = Math.floor(idx / rw);
            for (const [ddx, ddy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
              const nx = dx + ddx, ny = dy + ddy;
              if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
              const ni = ny * rw + nx;
              if (distMap[ni] >= 0) continue;
              distMap[ni] = d + 1;
              distQueue.push(ni);
            }
          }

          let newSeeds = 0;
          for (let k = 0; k < rw * rh; k++) {
            if (tattooMask[k] || !bodyMask[k]) continue;
            if (distMap[k] < 0 || distMap[k] > MAX_SEARCH_DIST) continue;
            const pi = k * 4;
            const pLab = rgbToLab(sd[pi], sd[pi + 1], sd[pi + 2]);
            const dist = Math.sqrt(
              (pLab[0] - medLab[0]) ** 2 +
              (pLab[1] - medLab[1]) ** 2 +
              (pLab[2] - medLab[2]) ** 2
            );
            if (dist >= SEED_THRESHOLD) {
              tattooMask[k] = 255;
              newSeeds++;
            }
          }
          totalNewSeeds += newSeeds;
          console.log(`[MASK DEBUG] Seed search round ${round + 1}: +${newSeeds} new seeds`);
          if (newSeeds === 0) break;
        }
        console.log(`[MASK DEBUG] Total new seeds from expanding search: ${totalNewSeeds}`);

        // Step 2c: Hysteresis growth — expand from all seeds (original +
        // newly found) into adjacent lighter ink pixels.
        const LOW_THRESHOLD = options.growthThreshold ?? 5;
        const growQueue = [];
        for (let k = 0; k < rw * rh; k++) {
          if (tattooMask[k]) growQueue.push(k);
        }
        let growHead = 0;
        let grownCount = 0;
        while (growHead < growQueue.length) {
          const idx = growQueue[growHead++];
          const hx = idx % rw, hy = Math.floor(idx / rw);
          for (const [ddx, ddy] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]]) {
            const nx = hx + ddx, ny = hy + ddy;
            if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
            const ni = ny * rw + nx;
            if (tattooMask[ni] || !bodyMask[ni]) continue;
            const pi = ni * 4;
            const pLab = rgbToLab(sd[pi], sd[pi + 1], sd[pi + 2]);
            const dist = Math.sqrt(
              (pLab[0] - medLab[0]) ** 2 +
              (pLab[1] - medLab[1]) ** 2 +
              (pLab[2] - medLab[2]) ** 2
            );
            if (dist >= LOW_THRESHOLD) {
              tattooMask[ni] = 255;
              growQueue.push(ni);
              grownCount++;
            }
          }
        }
        console.log(`[MASK DEBUG] Hysteresis growth (LAB>=${LOW_THRESHOLD}): +${grownCount} pixels`);

        // DIAGNOSTIC: sample unmasked pixels adjacent to mask boundary
        const edgeSamples = { noBody: 0, belowThreshold: [], aboveThreshold: 0 };
        for (let y = 1; y < rh - 1; y++) {
          for (let x = 1; x < rw - 1; x++) {
            if (tattooMask[y * rw + x]) continue;
            // Check if adjacent to a masked pixel
            let adjMask = false;
            for (const [ddx, ddy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
              if (tattooMask[(y + ddy) * rw + (x + ddx)]) { adjMask = true; break; }
            }
            if (!adjMask) continue;
            // This pixel is right next to the mask but not included
            if (!bodyMask[y * rw + x]) {
              edgeSamples.noBody++;
              continue;
            }
            const pi = (y * rw + x) * 4;
            const pLab = rgbToLab(sd[pi], sd[pi + 1], sd[pi + 2]);
            const dist = Math.sqrt(
              (pLab[0] - medLab[0]) ** 2 +
              (pLab[1] - medLab[1]) ** 2 +
              (pLab[2] - medLab[2]) ** 2
            );
            if (dist >= LOW_THRESHOLD) {
              edgeSamples.aboveThreshold++;
            } else {
              edgeSamples.belowThreshold.push(dist);
            }
          }
        }
        edgeSamples.belowThreshold.sort((a, b) => b - a);
        const topDists = edgeSamples.belowThreshold.slice(0, 30).map(d => d.toFixed(2));
        console.log(`[MASK DIAG] Unmasked pixels adjacent to mask edge:`);
        console.log(`  - Not body (BodyPix excluded): ${edgeSamples.noBody}`);
        console.log(`  - Body but LAB < ${LOW_THRESHOLD}: ${edgeSamples.belowThreshold.length} (top distances: ${topDists.join(', ')})`);
        console.log(`  - Body and LAB >= ${LOW_THRESHOLD} (SHOULD have been caught!): ${edgeSamples.aboveThreshold}`);
        console.log(`  - Median skin ref: L=${medLab[0].toFixed(1)} a=${medLab[1].toFixed(1)} b=${medLab[2].toFixed(1)} (RGB ${medR},${medG},${medB})`);

        // Step 2c: Skin proximity filter — remove clothing.
        // Tattoo ink is always ON skin, so tattoo pixels have skin-colored
        // neighbors. Clothing (shirts, etc) has no nearby skin pixels.
        // Build a grid of skin density, then exclude tattoo candidates
        // in blocks where no nearby block has skin.
        const BLOCK = 24;
        const gW = Math.ceil(rw / BLOCK);
        const gH = Math.ceil(rh / BLOCK);
        const skinGrid = new Float32Array(gW * gH);

        for (let gy = 0; gy < gH; gy++) {
          for (let gx = 0; gx < gW; gx++) {
            let skinCount = 0, bodyCount = 0;
            const y0 = gy * BLOCK, y1 = Math.min(y0 + BLOCK, rh);
            const x0 = gx * BLOCK, x1 = Math.min(x0 + BLOCK, rw);
            for (let ly = y0; ly < y1; ly++) {
              for (let lx = x0; lx < x1; lx++) {
                if (!bodyMask[ly * rw + lx]) continue;
                bodyCount++;
                const pi = (ly * rw + lx) * 4;
                if (isSkinPixel(sd[pi], sd[pi + 1], sd[pi + 2])) skinCount++;
              }
            }
            skinGrid[gy * gW + gx] = bodyCount > 0 ? skinCount / bodyCount : 0;
          }
        }

        // Precompute per-block: does ANY block within search radius have skin?
        // Search radius scales with bbox so dense tattoo centers can reach skin at edges.
        const MIN_SKIN_DENSITY = 0.10;
        const searchBlocks = Math.max(3, Math.ceil(Math.max(rw, rh) / BLOCK / 2));
        const hasNearbySkin = new Uint8Array(gW * gH);
        for (let bgy = 0; bgy < gH; bgy++) {
          for (let bgx = 0; bgx < gW; bgx++) {
            let found = false;
            for (let dy = -searchBlocks; dy <= searchBlocks && !found; dy++) {
              for (let dx = -searchBlocks; dx <= searchBlocks && !found; dx++) {
                const nx = bgx + dx, ny = bgy + dy;
                if (nx >= 0 && nx < gW && ny >= 0 && ny < gH) {
                  if (skinGrid[ny * gW + nx] >= MIN_SKIN_DENSITY) found = true;
                }
              }
            }
            if (found) hasNearbySkin[bgy * gW + bgx] = 1;
          }
        }

        // Filter pixels using precomputed block flags
        let clothingRemoved = 0;
        for (let y = 0; y < rh; y++) {
          for (let x = 0; x < rw; x++) {
            if (!tattooMask[y * rw + x]) continue;
            const gx = Math.floor(x / BLOCK);
            const gy = Math.floor(y / BLOCK);
            if (!hasNearbySkin[gy * gW + gx]) {
              tattooMask[y * rw + x] = 0;
              clothingRemoved++;
            }
          }
        }
        console.log(`[MASK DEBUG] Clothing filter: searchBlocks=${searchBlocks}, removed ${clothingRemoved} pixels`);

        // Remove small noise blobs (< 50 pixels)
        const ccLabels = new Int32Array(rw * rh);
        let nextLabel = 1;
        const componentSizes = new Map();
        for (let y = 0; y < rh; y++) {
          for (let x = 0; x < rw; x++) {
            if (!tattooMask[y * rw + x] || ccLabels[y * rw + x]) continue;
            const label = nextLabel++;
            const queue = [[x, y]];
            let head = 0;
            let size = 0;
            ccLabels[y * rw + x] = label;
            while (head < queue.length) {
              const [cx, cy] = queue[head++];
              size++;
              for (const [ddx, ddy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                const nx = cx + ddx, ny = cy + ddy;
                if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
                const ni = ny * rw + nx;
                if (!tattooMask[ni] || ccLabels[ni]) continue;
                ccLabels[ni] = label;
                queue.push([nx, ny]);
              }
            }
            componentSizes.set(label, size);
          }
        }

        const MIN_COMPONENT = 50;
        const dilated = new Uint8Array(rw * rh);
        for (let k = 0; k < rw * rh; k++) {
          if (ccLabels[k] && componentSizes.get(ccLabels[k]) >= MIN_COMPONENT) {
            dilated[k] = 255;
          }
        }

        let dilatedCount = 0;
        for (let k = 0; k < rw * rh; k++) if (dilated[k]) dilatedCount++;
        console.log(`[MASK DEBUG] After noise removal (>${MIN_COMPONENT}px): ${dilatedCount} pixels`);

        const constrained = dilated;
        let constrainedCount = 0;
        for (let k = 0; k < rw * rh; k++) { if (constrained[k]) constrainedCount++; }
        console.log(`[MASK DEBUG] Final mask: ${constrainedCount} pixels`);

        // Write to mask canvas
        const tempCanvas2 = document.createElement('canvas');
        tempCanvas2.width = width;
        tempCanvas2.height = height;
        const tempCtx2 = tempCanvas2.getContext('2d');
        const imgData = tempCtx2.createImageData(width, height);
        const d = imgData.data;

        for (let y = 0; y < rh; y++) {
          for (let x = 0; x < rw; x++) {
            if (constrained[y * rw + x]) {
              const di = ((regionTop + y) * width + (regionLeft + x)) * 4;
              d[di] = 255;
              d[di + 1] = 255;
              d[di + 2] = 255;
              d[di + 3] = 255;
            }
          }
        }

        tempCtx2.putImageData(imgData, 0, 0);
        ctx.drawImage(tempCanvas2, 0, 0);
      }

    } else if (hasSeg && !isTattoo) {
      // Face: BodyPix pixel-accurate approach
      const { data: partData, width: segW, height: segH } = det.segData;

      const faceW = det.bottomRight[0] - det.topLeft[0];
      const faceH = det.bottomRight[1] - det.topLeft[1];
      const faceCx = (det.topLeft[0] + det.bottomRight[0]) / 2;
      const faceCy = (det.topLeft[1] + det.bottomRight[1]) / 2;

      const regionLeft = Math.max(0, faceCx - faceW * 0.85);
      const regionRight = Math.min(width, faceCx + faceW * 0.85);
      const regionTop = Math.max(0, faceCy - faceH * 1.0);
      const regionBottom = Math.min(height, faceCy + faceH * 0.65);

      const sx = segW / width;
      const sy = segH / height;

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = width;
      tempCanvas.height = height;
      const tempCtx = tempCanvas.getContext('2d');
      const imgData = tempCtx.createImageData(width, height);
      const d = imgData.data;

      for (let y = Math.floor(regionTop); y < Math.ceil(regionBottom); y++) {
        for (let x = Math.floor(regionLeft); x < Math.ceil(regionRight); x++) {
          const segX = Math.floor(x * sx);
          const segY = Math.floor(y * sy);
          const partId = partData[segY * segW + segX];

          if (partId >= 0) {
            const di = (y * width + x) * 4;
            d[di] = 255;
            d[di + 1] = 255;
            d[di + 2] = 255;
            d[di + 3] = 255;
          }
        }
      }

      tempCtx.putImageData(imgData, 0, 0);

      ctx.save();
      ctx.filter = 'blur(4px)';
      ctx.drawImage(tempCanvas, 0, 0);
      ctx.filter = 'none';
      ctx.restore();

    } else if (det.contour && det.contour.length >= 3) {
      // Contour fallback
      const contour = det.contour;
      let cx = 0, cy = 0;
      for (const [x, y] of contour) { cx += x; cy += y; }
      cx /= contour.length;
      cy /= contour.length;

      const expanded = contour.map(([px, py]) => {
        const dx = px - cx;
        const dy = py - cy;
        return [cx + dx * 1.25, cy + dy * (dy < 0 ? 1.4 : 1.12)];
      });

      ctx.save();
      ctx.filter = 'blur(4px)';
      ctx.beginPath();
      ctx.moveTo(expanded[0][0], expanded[0][1]);
      for (let j = 1; j < expanded.length; j++) {
        ctx.lineTo(expanded[j][0], expanded[j][1]);
      }
      ctx.closePath();
      ctx.fillStyle = 'white';
      ctx.fill();
      ctx.filter = 'none';
      ctx.restore();
    } else {
      // Ellipse fallback
      const x1 = det.topLeft[0];
      const y1 = det.topLeft[1];
      const x2 = det.bottomRight[0];
      const y2 = det.bottomRight[1];
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      const rw = ((x2 - x1) / 2) * 1.2;
      const rh = ((y2 - y1) / 2) * 1.2;

      ctx.save();
      ctx.beginPath();
      ctx.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'white';
      ctx.fill();
      ctx.restore();
    }
  });

  return canvas;
}

/**
 * Refine a rough hand-painted mask to only ink pixels.
 * Samples skin color from just outside the painted boundary,
 * then keeps only pixels inside the mask that differ from skin.
 *
 * @param {HTMLCanvasElement} imageCanvas - source image
 * @param {HTMLCanvasElement} maskCanvas  - rough painted mask (white = masked)
 * @returns {HTMLCanvasElement} refined mask canvas
 */
export function refineMask(imageCanvas, maskCanvas) {
  const { width, height } = imageCanvas;
  const srcData = imageCanvas.getContext('2d').getImageData(0, 0, width, height).data;
  const maskData = maskCanvas.getContext('2d').getImageData(0, 0, width, height).data;

  // Build binary mask
  const mask = new Uint8Array(width * height);
  let maskCount = 0;
  for (let i = 0; i < width * height; i++) {
    if (maskData[i * 4 + 3] > 128) { mask[i] = 1; maskCount++; }
  }

  if (maskCount === 0) return maskCanvas;

  // Sample skin color from border ring just outside the mask (8px margin)
  const MARGIN = 8;
  let skinR = 0, skinG = 0, skinB = 0, skinCount = 0;
  for (let i = 0; i < width * height; i++) {
    if (mask[i]) continue;
    const x = i % width, y = Math.floor(i / width);
    // Check if near mask
    let nearMask = false;
    for (let dy = -MARGIN; dy <= MARGIN && !nearMask; dy++) {
      for (let dx = -MARGIN; dx <= MARGIN && !nearMask; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && mask[ny * width + nx]) {
          nearMask = true;
        }
      }
    }
    if (!nearMask) continue;
    const pi = i * 4;
    const r = srcData[pi], g = srcData[pi + 1], b = srcData[pi + 2];
    if (isSkinPixel(r, g, b)) {
      skinR += r; skinG += g; skinB += b; skinCount++;
    }
  }

  if (skinCount < 10) {
    console.log(`[RefineMask] Only ${skinCount} border skin pixels, returning original mask`);
    return maskCanvas;
  }

  skinR /= skinCount; skinG /= skinCount; skinB /= skinCount;
  const skinLab = rgbToLab(Math.round(skinR), Math.round(skinG), Math.round(skinB));
  console.log(`[RefineMask] Border skin: ${skinCount} px, mean RGB(${skinR.toFixed(0)}, ${skinG.toFixed(0)}, ${skinB.toFixed(0)})`);

  // Pass 1: Seed — keep masked pixels with high LAB distance from skin
  const SEED_THRESHOLD = 12;
  const refined = new Uint8Array(width * height);
  let seedCount = 0;
  for (let i = 0; i < width * height; i++) {
    if (!mask[i]) continue;
    const pi = i * 4;
    const lab = rgbToLab(srcData[pi], srcData[pi + 1], srcData[pi + 2]);
    const dist = Math.sqrt(
      (lab[0] - skinLab[0]) ** 2 +
      (lab[1] - skinLab[1]) ** 2 +
      (lab[2] - skinLab[2]) ** 2
    );
    if (dist >= SEED_THRESHOLD) {
      refined[i] = 1;
      seedCount++;
    }
  }
  console.log(`[RefineMask] Seeds (LAB>=${SEED_THRESHOLD}): ${seedCount}/${maskCount} (${(seedCount/maskCount*100).toFixed(1)}%)`);

  // Pass 2: Hysteresis grow — expand from seeds into adjacent lighter ink
  const GROW_THRESHOLD = 6;
  const growQueue = [];
  for (let i = 0; i < width * height; i++) {
    if (refined[i]) growQueue.push(i);
  }
  let gi = 0, grownCount = 0;
  while (gi < growQueue.length) {
    const idx = growQueue[gi++];
    const x = idx % width, y = Math.floor(idx / width);
    for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = ny * width + nx;
      if (refined[ni] || !mask[ni]) continue; // must be within original mask
      const pi = ni * 4;
      const lab = rgbToLab(srcData[pi], srcData[pi + 1], srcData[pi + 2]);
      const dist = Math.sqrt(
        (lab[0] - skinLab[0]) ** 2 +
        (lab[1] - skinLab[1]) ** 2 +
        (lab[2] - skinLab[2]) ** 2
      );
      if (dist >= GROW_THRESHOLD) {
        refined[ni] = 1;
        growQueue.push(ni);
        grownCount++;
      }
    }
  }

  const finalCount = seedCount + grownCount;
  console.log(`[RefineMask] Grown: +${grownCount}, final: ${finalCount}/${maskCount} (${(finalCount/maskCount*100).toFixed(1)}% of original mask)`);

  // If refinement removed too much (>90%), the mask was probably already tight
  // or the tattoo is very skin-like — fall back to original
  if (finalCount < maskCount * 0.1) {
    console.log(`[RefineMask] Refinement too aggressive (<10% retained), using original mask`);
    return maskCanvas;
  }

  // Build output canvas
  const outCanvas = document.createElement('canvas');
  outCanvas.width = width;
  outCanvas.height = height;
  const outCtx = outCanvas.getContext('2d');
  const outData = outCtx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    if (refined[i]) {
      const di = i * 4;
      outData.data[di] = 255;
      outData.data[di + 1] = 255;
      outData.data[di + 2] = 255;
      outData.data[di + 3] = 255;
    }
  }
  outCtx.putImageData(outData, 0, 0);
  return outCanvas;
}
