import { useCallback } from 'react';
import { usePipeline } from '../context/PipelineContext';
import { useFaceDetection } from './useFaceDetection';
import { extractMetadata } from '../utils/metadataExtractor';
import { fileToCanvas, createFaceMask, refineMask, isSkinPixel } from '../utils/imageHelpers';
import { applyMaskedBlur } from '../utils/blurEngine';
import { patchMatchInpaint } from '../utils/patchMatchInpaint';
import { poissonBlend } from '../utils/poissonBlend';
import { saveTrainingPair } from '../utils/trainingDataStore';

/**
 * Inpaint tattoos using per-region PatchMatch + Poisson blending.
 * Each tattoo is processed independently on its localized region for
 * better source context and faster computation.
 */
/**
 * Inpaint masked regions using PatchMatch + Poisson blending.
 * Takes a source canvas and a mask canvas (white = inpaint).
 */
async function inpaintFromMask(sourceCanvas, maskCanvas) {
  const { width, height } = sourceCanvas;
  const srcCtx = sourceCanvas.getContext('2d');
  const srcData = srcCtx.getImageData(0, 0, width, height);
  const origPixels = new Uint8Array(srcData.data);

  const tmCtx = maskCanvas.getContext('2d');
  const tmData = tmCtx.getImageData(0, 0, width, height);

  // Find mask bounding rect
  let minX = width, minY = height, maxX = 0, maxY = 0;
  let anyMasked = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (tmData.data[(y * width + x) * 4 + 3] > 128) {
        anyMasked = true;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (!anyMasked) {
    const out = document.createElement('canvas');
    out.width = width; out.height = height;
    out.getContext('2d').drawImage(sourceCanvas, 0, 0);
    return out;
  }

  const margin = 30;
  const rx0 = Math.max(0, minX - margin);
  const ry0 = Math.max(0, minY - margin);
  const rx1 = Math.min(width, maxX + margin + 1);
  const ry1 = Math.min(height, maxY + margin + 1);
  const rw = rx1 - rx0;
  const rh = ry1 - ry0;

  const regionOrig = new Uint8Array(rw * rh * 4);
  const regionWork = new Uint8Array(rw * rh * 4);
  const regionMask = new Uint8Array(rw * rh);
  let regionMaskedCount = 0;

  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const si = ((ry0 + y) * width + (rx0 + x)) * 4;
      const di = (y * rw + x) * 4;
      regionOrig[di]   = origPixels[si];
      regionOrig[di+1] = origPixels[si+1];
      regionOrig[di+2] = origPixels[si+2];
      regionOrig[di+3] = origPixels[si+3];
      regionWork[di]   = origPixels[si];
      regionWork[di+1] = origPixels[si+1];
      regionWork[di+2] = origPixels[si+2];
      regionWork[di+3] = origPixels[si+3];
      if (tmData.data[si + 3] > 128) {
        regionMask[y * rw + x] = 1;
        regionMaskedCount++;
      }
    }
  }

  console.log(`[PIPELINE] Inpainting ${regionMaskedCount} pixels in ${rw}x${rh} region`);
  patchMatchInpaint(regionWork, regionMask, rw, rh);
  const regionOutput = new Uint8Array(rw * rh * 4);
  poissonBlend(regionOrig, regionWork, regionMask, rw, rh, regionOutput);

  // Feathered composite
  const outCanvas = document.createElement('canvas');
  outCanvas.width = width;
  outCanvas.height = height;
  const outCtx = outCanvas.getContext('2d');
  outCtx.drawImage(sourceCanvas, 0, 0);
  const outData = outCtx.getImageData(0, 0, width, height);
  const outPixels = outData.data;

  const FEATHER_RADIUS = 8;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      if (!regionMask[y * rw + x]) continue;
      const farN = y >= FEATHER_RADIUS && regionMask[(y - FEATHER_RADIUS) * rw + x];
      const farS = (y + FEATHER_RADIUS) < rh && regionMask[(y + FEATHER_RADIUS) * rw + x];
      const farW = x >= FEATHER_RADIUS && regionMask[y * rw + (x - FEATHER_RADIUS)];
      const farE = (x + FEATHER_RADIUS) < rw && regionMask[y * rw + (x + FEATHER_RADIUS)];
      let alpha;
      if (farN && farS && farW && farE) {
        alpha = 1.0;
      } else {
        let minDist = FEATHER_RADIUS + 1;
        for (let dy = -FEATHER_RADIUS; dy <= FEATHER_RADIUS && minDist > 1; dy++) {
          for (let dx = -FEATHER_RADIUS; dx <= FEATHER_RADIUS; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) {
              const d = Math.sqrt(dx * dx + dy * dy);
              if (d < minDist) minDist = d;
              continue;
            }
            if (!regionMask[ny * rw + nx]) {
              const d = Math.sqrt(dx * dx + dy * dy);
              if (d < minDist) minDist = d;
            }
          }
        }
        if (minDist <= FEATHER_RADIUS) {
          const t = minDist / FEATHER_RADIUS;
          alpha = t * t * (3 - 2 * t);
        } else {
          alpha = 1.0;
        }
      }
      const ri = (y * rw + x) * 4;
      const oi = ((ry0 + y) * width + (rx0 + x)) * 4;
      outPixels[oi]   = Math.round(origPixels[oi]   * (1 - alpha) + regionOutput[ri]   * alpha);
      outPixels[oi+1] = Math.round(origPixels[oi+1] * (1 - alpha) + regionOutput[ri+1] * alpha);
      outPixels[oi+2] = Math.round(origPixels[oi+2] * (1 - alpha) + regionOutput[ri+2] * alpha);
    }
  }
  outCtx.putImageData(outData, 0, 0);
  return outCanvas;
}

/**
 * Composite: blur faces using detection results.
 */
function compositeOutput(sourceCanvas, detections, toggles, blurMode, blurStrength) {
  const { width, height } = sourceCanvas;
  const faceMask = createFaceMask(
    width, height,
    detections,
    toggles
  );
  // Pass active detections for blackbar eye positioning
  const activeDetections = detections.filter((_, i) => !toggles || toggles[i] !== false);
  return applyMaskedBlur(sourceCanvas, faceMask, blurMode, blurStrength, activeDetections);
}

export function useImagePipeline() {
  const {
    setMetadata,
    setDetections,
    setDetectionToggles,
    setStatus,
    setError,
    strippedCanvasRef,
    originalCanvasRef,
    maskCanvasRef,
    outputCanvasRef,
    tattooMaskCanvasRef,
    samScaleRef,
    inpaintedCanvasRef,
    blurSettings,
    setScreen,
  } = usePipeline();

  const { detect } = useFaceDetection();

  const runPipeline = useCallback(async (file) => {
    try {
      // Step 1: Extract metadata
      setStatus('stripping');
      setError(null);

      const meta = await extractMetadata(file);
      setMetadata(meta);

      // Step 2: Strip metadata by re-encoding through canvas
      const cleanCanvas = await fileToCanvas(file);
      strippedCanvasRef.current = cleanCanvas;

      // Preserve original for comparison (before any inpainting)
      const origCopy = document.createElement('canvas');
      origCopy.width = cleanCanvas.width;
      origCopy.height = cleanCanvas.height;
      origCopy.getContext('2d').drawImage(cleanCanvas, 0, 0);
      originalCanvasRef.current = origCopy;

      // Create initial output (no face blur yet — deferred to apply step)
      const output = document.createElement('canvas');
      output.width = cleanCanvas.width;
      output.height = cleanCanvas.height;
      output.getContext('2d').drawImage(cleanCanvas, 0, 0);
      outputCanvasRef.current = output;

      // Auto-suggest tattoo mask if trained model exists, else empty
      const suggestedMask = document.createElement('canvas');
      suggestedMask.width = cleanCanvas.width;
      suggestedMask.height = cleanCanvas.height;
      try {
        const { loadTattooSegModel, predictTattooMask, isTattooSegModelTrained } = await import('../utils/tattooSegModel');
        const hasTrained = await isTattooSegModelTrained();
        if (hasTrained) {
          const model = await loadTattooSegModel();
          if (model) {
            const predicted = await predictTattooMask(model, cleanCanvas);
            if (predicted) {
              suggestedMask.getContext('2d').drawImage(predicted, 0, 0);
              console.log('[PIPELINE] Auto-suggested tattoo mask from trained model');
            }
          }
        }
      } catch (err) {
        console.warn('[PIPELINE] Auto-suggest failed, using empty mask:', err.message);
      }
      tattooMaskCanvasRef.current = suggestedMask;

      setStatus('ready');
      setScreen('mask-edit');
    } catch (err) {
      console.error('Pipeline error:', err);
      setError(err.message || 'Processing failed');
      setStatus('error');
    }
  }, [setMetadata, setStatus, setError, setScreen, strippedCanvasRef, outputCanvasRef]);

  const recomposite = useCallback(async (detections, toggles, settings) => {
    // Use inpainted canvas as base if available (from mask editor path),
    // otherwise fall back to stripped canvas (from auto-detect path)
    const baseCanvas = inpaintedCanvasRef.current || strippedCanvasRef.current;
    if (!baseCanvas) return;

    detections.forEach(d => {
      if (d.type === 'tattoo' && !d._sourceCanvas) {
        d._sourceCanvas = baseCanvas;
      }
    });

    const combinedMask = createFaceMask(
      baseCanvas.width,
      baseCanvas.height,
      detections,
      toggles
    );
    maskCanvasRef.current = combinedMask;

    const output = await compositeOutput(
      baseCanvas, detections, toggles,
      settings.mode, settings.strength
    );
    outputCanvasRef.current = output;
  }, [strippedCanvasRef, inpaintedCanvasRef, maskCanvasRef, outputCanvasRef]);

  /**
   * Composite using a user-painted tattoo mask (from mask editor).
   * Inpaints the masked tattoo regions, then applies face blur.
   */
  const recompositeWithCustomMask = useCallback(async (customTattooMask, subjectName = 'default', { dilateRadius = 12, featherRadius = 16, faceBlur = false, exclusionMask = null, onProgress = null } = {}) => {
    if (!strippedCanvasRef.current) return;

    const src = strippedCanvasRef.current;
    const { width, height } = src;
    let current = src;

    // Inpaint tattoos using the custom mask
    if (customTattooMask) {
      const tmCtx = customTattooMask.getContext('2d');
      const tmData = tmCtx.getImageData(0, 0, width, height);

      // Read exclusion mask data (pixels to hide from LaMa context)
      let exData = null;
      if (exclusionMask) {
        exData = exclusionMask.getContext('2d').getImageData(0, 0, width, height);
      }

      let anyMasked = false;
      let maskCount = 0;
      for (let i = 0; i < width * height; i++) {
        if (tmData.data[i * 4 + 3] > 128) { anyMasked = true; maskCount++; }
      }

      if (anyMasked) {
        try {
          // Refine rough mask to ink-only pixels for training data
          const refinedTattooMask = refineMask(src, customTattooMask);
          const rtmCtx = refinedTattooMask.getContext('2d');
          const rtmData = rtmCtx.getImageData(0, 0, width, height);
          let refinedCount = 0;
          for (let i = 0; i < width * height; i++) {
            if (rtmData.data[i * 4 + 3] > 128) refinedCount++;
          }
          console.log(`[PIPELINE] Mask refinement: ${maskCount} rough → ${refinedCount} refined`);

          // For INPAINTING, fill interior gaps in the ink-only mask.
          // The smart brush only masks ink pixels, leaving skin gaps between ink lines.
          // Flood fill from image border finds exterior; everything else = interior gap.
          // Then dilate slightly to expand boundary for smoother blending.
          const inpaintMask = new Uint8Array(width * height);
          for (let i = 0; i < width * height; i++) {
            inpaintMask[i] = tmData.data[i * 4 + 3] > 128 ? 1 : 0;
          }

          // Flood fill from image border to find exterior (non-mask, connected to edge)
          const exterior = new Uint8Array(width * height);
          const fillQueue = [];
          // Seed border pixels that are not masked
          for (let x = 0; x < width; x++) {
            if (!inpaintMask[x] && !exterior[x]) { exterior[x] = 1; fillQueue.push(x); }
            const bi = (height - 1) * width + x;
            if (!inpaintMask[bi] && !exterior[bi]) { exterior[bi] = 1; fillQueue.push(bi); }
          }
          for (let y = 1; y < height - 1; y++) {
            const li = y * width;
            if (!inpaintMask[li] && !exterior[li]) { exterior[li] = 1; fillQueue.push(li); }
            const ri = y * width + width - 1;
            if (!inpaintMask[ri] && !exterior[ri]) { exterior[ri] = 1; fillQueue.push(ri); }
          }
          let fqi = 0;
          while (fqi < fillQueue.length) {
            const idx = fillQueue[fqi++];
            const fx = idx % width;
            const fy = (idx - fx) / width;
            if (fx > 0)          { const ni = idx - 1;     if (!exterior[ni] && !inpaintMask[ni]) { exterior[ni] = 1; fillQueue.push(ni); } }
            if (fx < width - 1)  { const ni = idx + 1;     if (!exterior[ni] && !inpaintMask[ni]) { exterior[ni] = 1; fillQueue.push(ni); } }
            if (fy > 0)          { const ni = idx - width;  if (!exterior[ni] && !inpaintMask[ni]) { exterior[ni] = 1; fillQueue.push(ni); } }
            if (fy < height - 1) { const ni = idx + width;  if (!exterior[ni] && !inpaintMask[ni]) { exterior[ni] = 1; fillQueue.push(ni); } }
          }

          // Fill interior gaps: pixels that are NOT mask AND NOT exterior = enclosed by mask
          let interiorFilled = 0;
          for (let i = 0; i < width * height; i++) {
            if (!inpaintMask[i] && !exterior[i]) {
              inpaintMask[i] = 1;
              interiorFilled++;
            }
          }

          // Dilation expands boundary past ink edges; combined with feathering gives smooth transition
          // Only dilate into skin-like pixels — prevents expansion into background
          // Two-phase dilation: unconditional inner halo (covers ink bleed
          // that isSkinPixel misses) + skin-constrained outer ring
          const DILATE_RADIUS = dilateRadius;
          const INK_HALO = 5;
          const srcData = src.getContext('2d').getImageData(0, 0, width, height).data;
          const dilated = new Uint8Array(width * height);
          let dilHalo = 0, dilSkin = 0, dilSkipped = 0;
          const halo2 = INK_HALO * INK_HALO;
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              if (inpaintMask[y * width + x]) { dilated[y * width + x] = 1; continue; }
              // Find distance to nearest mask pixel
              let minDist2 = (DILATE_RADIUS + 1) * (DILATE_RADIUS + 1);
              for (let dy = -DILATE_RADIUS; dy <= DILATE_RADIUS; dy++) {
                for (let dx = -DILATE_RADIUS; dx <= DILATE_RADIUS; dx++) {
                  const d2 = dx * dx + dy * dy;
                  if (d2 >= minDist2 || d2 > DILATE_RADIUS * DILATE_RADIUS) continue;
                  const ny = y + dy, nx = x + dx;
                  if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
                    if (inpaintMask[ny * width + nx]) {
                      minDist2 = d2;
                      if (d2 <= halo2) break;
                    }
                  }
                }
                if (minDist2 <= halo2) break;
              }
              if (minDist2 > DILATE_RADIUS * DILATE_RADIUS) continue;
              if (minDist2 <= halo2) {
                // Inner halo: unconditional — covers ink bleed regardless of skin detection
                dilated[y * width + x] = 1;
                dilHalo++;
              } else {
                // Outer ring: skin-constrained to prevent expansion into background
                const pi = (y * width + x) * 4;
                if (isSkinPixel(srcData[pi], srcData[pi + 1], srcData[pi + 2])) {
                  dilated[y * width + x] = 1;
                  dilSkin++;
                } else {
                  dilSkipped++;
                }
              }
            }
          }
          console.log(`[PIPELINE] Dilation: ${dilHalo} halo + ${dilSkin} skin px added, ${dilSkipped} non-skin px skipped`);

          // Build ImageData-like structure for BFS
          let closedCount = 0;
          const closedData = { data: new Uint8Array(width * height * 4) };
          for (let i = 0; i < width * height; i++) {
            if (dilated[i]) {
              closedData.data[i * 4 + 3] = 255;
              closedCount++;
            }
          }
          const dilateAdded = closedCount - maskCount - interiorFilled;
          console.log(`[PIPELINE] Mask fill: ${maskCount} ink → +${interiorFilled} interior → +${dilateAdded} dilated = ${closedCount} total`);

          // Find connected components in the closed mask via BFS
          const visited = new Uint8Array(width * height);
          const components = [];
          for (let startIdx = 0; startIdx < width * height; startIdx++) {
            if (visited[startIdx] || closedData.data[startIdx * 4 + 3] <= 128) continue;
            const comp = { pixels: [], minX: width, minY: height, maxX: 0, maxY: 0 };
            const queue = [startIdx];
            let qi = 0;
            visited[startIdx] = 1;
            while (qi < queue.length) {
              const ci = queue[qi++];
              const cx = ci % width;
              const cy = (ci - cx) / width;
              comp.pixels.push(ci);
              if (cx < comp.minX) comp.minX = cx;
              if (cy < comp.minY) comp.minY = cy;
              if (cx > comp.maxX) comp.maxX = cx;
              if (cy > comp.maxY) comp.maxY = cy;
              if (cx > 0)          { const ni = ci - 1;     if (!visited[ni] && closedData.data[ni * 4 + 3] > 128) { visited[ni] = 1; queue.push(ni); } }
              if (cx < width - 1)  { const ni = ci + 1;     if (!visited[ni] && closedData.data[ni * 4 + 3] > 128) { visited[ni] = 1; queue.push(ni); } }
              if (cy > 0)          { const ni = ci - width;  if (!visited[ni] && closedData.data[ni * 4 + 3] > 128) { visited[ni] = 1; queue.push(ni); } }
              if (cy < height - 1) { const ni = ci + width;  if (!visited[ni] && closedData.data[ni * 4 + 3] > 128) { visited[ni] = 1; queue.push(ni); } }
            }
            if (comp.pixels.length >= 50) components.push(comp);
          }

          // If closed mask produced 0 valid components, retry BFS with the original mask
          if (components.length === 0) {
            console.log('[PIPELINE] Closed mask produced 0 components, falling back to original mask');
            visited.fill(0);
            for (let startIdx = 0; startIdx < width * height; startIdx++) {
              if (visited[startIdx] || tmData.data[startIdx * 4 + 3] <= 128) continue;
              const comp = { pixels: [], minX: width, minY: height, maxX: 0, maxY: 0 };
              const queue = [startIdx];
              let qi = 0;
              visited[startIdx] = 1;
              while (qi < queue.length) {
                const ci = queue[qi++];
                const cx = ci % width;
                const cy = (ci - cx) / width;
                comp.pixels.push(ci);
                if (cx < comp.minX) comp.minX = cx;
                if (cy < comp.minY) comp.minY = cy;
                if (cx > comp.maxX) comp.maxX = cx;
                if (cy > comp.maxY) comp.maxY = cy;
                if (cx > 0)          { const ni = ci - 1;     if (!visited[ni] && tmData.data[ni * 4 + 3] > 128) { visited[ni] = 1; queue.push(ni); } }
                if (cx < width - 1)  { const ni = ci + 1;     if (!visited[ni] && tmData.data[ni * 4 + 3] > 128) { visited[ni] = 1; queue.push(ni); } }
                if (cy > 0)          { const ni = ci - width;  if (!visited[ni] && tmData.data[ni * 4 + 3] > 128) { visited[ni] = 1; queue.push(ni); } }
                if (cy < height - 1) { const ni = ci + width;  if (!visited[ni] && tmData.data[ni * 4 + 3] > 128) { visited[ni] = 1; queue.push(ni); } }
              }
              if (comp.pixels.length >= 50) components.push(comp);
            }
          }

          // Sort smallest first — easier regions build clean context for harder ones
          components.sort((a, b) => a.pixels.length - b.pixels.length);
          console.log(`[PIPELINE] Found ${components.length} mask region(s) to inpaint`);

          // Import LaMa once
          let lamaInpaintFn = null;
          try {
            if (onProgress) onProgress('Loading AI model...');
            const lamaModule = await import('../utils/lamaInpaint');
            lamaInpaintFn = lamaModule.lamaInpaintRegion;
            if (onProgress) onProgress('AI model ready');
          } catch (e) {
            console.warn('[PIPELINE] LaMa unavailable, will use PatchMatch:', e.message);
          }

          // Accumulating output canvas — updated after each region
          const outCanvas = document.createElement('canvas');
          outCanvas.width = width;
          outCanvas.height = height;
          outCanvas.getContext('2d').drawImage(src, 0, 0);

          for (let ci = 0; ci < components.length; ci++) {
            const comp = components[ci];
            console.log(`[PIPELINE] Region ${ci + 1}/${components.length}: ${comp.pixels.length}px, bbox ${comp.maxX - comp.minX}x${comp.maxY - comp.minY}`);

            // Build per-component binary mask
            const compMask = new Uint8Array(width * height);
            for (const idx of comp.pixels) compMask[idx] = 1;

            let { minX, minY, maxX, maxY } = comp;

            // Auto-extend mask to image edges if within 15px
            const EDGE_SNAP = 15;
            if (minX < EDGE_SNAP) {
              for (let y = minY; y <= maxY; y++)
                for (let x = 0; x < minX; x++) compMask[y * width + x] = 1;
              minX = 0;
            }
            if (minY < EDGE_SNAP) {
              for (let y = 0; y < minY; y++)
                for (let x = minX; x <= maxX; x++) compMask[y * width + x] = 1;
              minY = 0;
            }
            if (maxX > width - EDGE_SNAP - 1) {
              for (let y = minY; y <= maxY; y++)
                for (let x = maxX + 1; x < width; x++) compMask[y * width + x] = 1;
              maxX = width - 1;
            }
            if (maxY > height - EDGE_SNAP - 1) {
              for (let y = maxY + 1; y < height; y++)
                for (let x = minX; x <= maxX; x++) compMask[y * width + x] = 1;
              maxY = height - 1;
            }

            // Tight margin: enough nearby skin for texture matching, less distant background
            const maskW = maxX - minX, maskH = maxY - minY;
            const margin = Math.max(30, Math.round(Math.max(maskW, maskH) * 0.15));
            const rx0 = Math.max(0, minX - margin);
            const ry0 = Math.max(0, minY - margin);
            const rx1 = Math.min(width, maxX + margin + 1);
            const ry1 = Math.min(height, maxY + margin + 1);
            const rw = rx1 - rx0;
            const rh = ry1 - ry0;

            // Extract region from current accumulated output
            const curPixels = new Uint8Array(outCanvas.getContext('2d').getImageData(0, 0, width, height).data);

            const regionOrig = new Uint8Array(rw * rh * 4);
            const regionWork = new Uint8Array(rw * rh * 4);
            const regionMask = new Uint8Array(rw * rh);      // tattoo only (for compositing)
            const lamaRegionMask = new Uint8Array(rw * rh);   // tattoo + exclusion (for LaMa)

            let exPixelsInRegion = 0;
            for (let y = 0; y < rh; y++) {
              for (let x = 0; x < rw; x++) {
                const gi = (ry0 + y) * width + (rx0 + x);
                const si = gi * 4;
                const di = (y * rw + x) * 4;
                regionOrig[di]   = curPixels[si];
                regionOrig[di+1] = curPixels[si+1];
                regionOrig[di+2] = curPixels[si+2];
                regionOrig[di+3] = curPixels[si+3];
                regionWork[di]   = curPixels[si];
                regionWork[di+1] = curPixels[si+1];
                regionWork[di+2] = curPixels[si+2];
                regionWork[di+3] = curPixels[si+3];
                if (compMask[gi]) {
                  regionMask[y * rw + x] = 1;
                  lamaRegionMask[y * rw + x] = 1;
                } else if (exData && exData.data[gi * 4 + 3] > 128) {
                  lamaRegionMask[y * rw + x] = 1;
                  exPixelsInRegion++;
                }
              }
            }
            if (exPixelsInRegion > 0) {
              console.log(`[PIPELINE] Region ${ci + 1}: ${exPixelsInRegion} exclusion px added to LaMa mask`);
            }

            // Inpaint this region
            if (onProgress) onProgress(`Inpainting region ${ci + 1} of ${components.length}...`);
            let regionOutput;
            let inpaintMethod = 'patchmatch';
            try {
              if (lamaInpaintFn) {
                // Pass merged mask (tattoo + exclusion) to LaMa so excluded
                // areas are inpainted rather than used as context
                regionOutput = await lamaInpaintFn(regionOrig, lamaRegionMask, rw, rh, { featherRadius });
                inpaintMethod = 'lama';
              } else {
                throw new Error('LaMa not loaded');
              }
            } catch (lamaErr) {
              patchMatchInpaint(regionWork, regionMask, rw, rh);
              regionOutput = new Uint8Array(rw * rh * 4);
              poissonBlend(regionOrig, regionWork, regionMask, rw, rh, regionOutput);
            }
            console.log(`[PIPELINE] Region ${ci + 1} inpainted via ${inpaintMethod}`);

            // DIAG: measure LaMa output before post-processing
            {
              let preSkin = 0, preNonSkin = 0;
              for (let y = 0; y < rh; y++) {
                for (let x = 0; x < rw; x++) {
                  if (!regionMask[y * rw + x]) continue;
                  const pi = (y * rw + x) * 4;
                  const r = regionOutput[pi], g = regionOutput[pi + 1], b = regionOutput[pi + 2];
                  if (r === 0 && g === 0 && b === 0) continue;
                  const isSkin = (() => {
                    const brightness = r * 0.299 + g * 0.587 + b * 0.114;
                    if (brightness < 25 || (brightness > 240 && (r - b) < 10)) return false;
                    if (b > r + 40 || g > r + 40) return false;
                    const max = Math.max(r, g, b), min = Math.min(r, g, b);
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
                  })();
                  if (isSkin) preSkin++; else preNonSkin++;
                }
              }
              console.log(`[PIPELINE DIAG] Pre-blur: skin=${preSkin}, non-skin=${preNonSkin} (${(preNonSkin/(preSkin+preNonSkin)*100).toFixed(1)}% non-skin)`);
            }

            // Light Gaussian blur on inpainted region
            const blurCanvas = document.createElement('canvas');
            blurCanvas.width = rw;
            blurCanvas.height = rh;
            const blurCtx = blurCanvas.getContext('2d');
            const blurImg = blurCtx.createImageData(rw, rh);
            blurImg.data.set(regionOutput);
            blurCtx.putImageData(blurImg, 0, 0);

            const smoothed = document.createElement('canvas');
            smoothed.width = rw;
            smoothed.height = rh;
            const smCtx = smoothed.getContext('2d');
            smCtx.filter = 'blur(2px)';
            smCtx.drawImage(blurCanvas, 0, 0);
            regionOutput = new Uint8Array(smCtx.getImageData(0, 0, rw, rh).data);

            // Feathered composite onto accumulated output
            const outCtx = outCanvas.getContext('2d');
            const outData = outCtx.getImageData(0, 0, width, height);
            const outPixels = outData.data;

            const edgeTop = ry0 === 0;
            const edgeBottom = ry1 === height;
            const edgeLeft = rx0 === 0;
            const edgeRight = rx1 === width;

            const FEATHER_RADIUS = featherRadius;
            for (let y = 0; y < rh; y++) {
              for (let x = 0; x < rw; x++) {
                if (!regionMask[y * rw + x]) continue;
                const farN = y >= FEATHER_RADIUS && regionMask[(y - FEATHER_RADIUS) * rw + x];
                const farS = (y + FEATHER_RADIUS) < rh && regionMask[(y + FEATHER_RADIUS) * rw + x];
                const farW = x >= FEATHER_RADIUS && regionMask[y * rw + (x - FEATHER_RADIUS)];
                const farE = (x + FEATHER_RADIUS) < rw && regionMask[y * rw + (x + FEATHER_RADIUS)];
                let alpha;
                if (farN && farS && farW && farE) {
                  alpha = 1.0;
                } else {
                  let minDist = FEATHER_RADIUS + 1;
                  for (let dy = -FEATHER_RADIUS; dy <= FEATHER_RADIUS && minDist > 1; dy++) {
                    for (let dx = -FEATHER_RADIUS; dx <= FEATHER_RADIUS; dx++) {
                      const nx = x + dx, ny = y + dy;
                      if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) {
                        const atImageEdge =
                          (ny < 0 && edgeTop) || (ny >= rh && edgeBottom) ||
                          (nx < 0 && edgeLeft) || (nx >= rw && edgeRight);
                        if (atImageEdge) continue;
                        const d = Math.sqrt(dx * dx + dy * dy);
                        if (d < minDist) minDist = d;
                        continue;
                      }
                      if (!regionMask[ny * rw + nx]) {
                        const d = Math.sqrt(dx * dx + dy * dy);
                        if (d < minDist) minDist = d;
                      }
                    }
                  }
                  alpha = minDist <= FEATHER_RADIUS
                    ? (() => { const t = minDist / FEATHER_RADIUS; const s = t * t * (3 - 2 * t); return Math.pow(s, 0.5); })()
                    : 1.0;
                }
                const ri = (y * rw + x) * 4;
                const oi = ((ry0 + y) * width + (rx0 + x)) * 4;
                outPixels[oi]   = Math.round(outPixels[oi]   * (1 - alpha) + regionOutput[ri]   * alpha);
                outPixels[oi+1] = Math.round(outPixels[oi+1] * (1 - alpha) + regionOutput[ri+1] * alpha);
                outPixels[oi+2] = Math.round(outPixels[oi+2] * (1 - alpha) + regionOutput[ri+2] * alpha);
              }
            }
            outCtx.putImageData(outData, 0, 0);

            // DIAG: measure final composited result for this region
            {
              const finalData = outCtx.getImageData(rx0, ry0, rw, rh).data;
              let finalAlpha0 = 0, finalAlpha1 = 0, finalAlphaPartial = 0;
              let finalSkin = 0, finalNonSkin = 0;
              const featherDists = [];
              for (let y = 0; y < rh; y++) {
                for (let x = 0; x < rw; x++) {
                  if (!regionMask[y * rw + x]) continue;
                  const pi = (y * rw + x) * 4;
                  const r = finalData[pi], g = finalData[pi + 1], b = finalData[pi + 2];
                  // Approximate if this was feathered by comparing to original
                  const oi = ((ry0 + y) * width + (rx0 + x)) * 4;
                  const origR = curPixels[oi], origG = curPixels[oi + 1], origB = curPixels[oi + 2];
                  const changeMag = Math.abs(r - origR) + Math.abs(g - origG) + Math.abs(b - origB);
                  if (changeMag < 3) finalAlpha0++;
                  else if (changeMag > 30) finalAlpha1++;
                  else finalAlphaPartial++;

                  const isSkin = (() => {
                    const brightness = r * 0.299 + g * 0.587 + b * 0.114;
                    if (brightness < 25 || (brightness > 240 && (r - b) < 10)) return false;
                    if (b > r + 40 || g > r + 40) return false;
                    const max = Math.max(r, g, b), min = Math.min(r, g, b);
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
                  })();
                  if (isSkin) finalSkin++; else finalNonSkin++;
                }
              }
              const totalMasked = finalAlpha0 + finalAlpha1 + finalAlphaPartial;
              console.log(`[PIPELINE DIAG] Post-composite region ${ci + 1}: unchanged=${finalAlpha0} (${(finalAlpha0/totalMasked*100).toFixed(1)}%), full-replace=${finalAlpha1} (${(finalAlpha1/totalMasked*100).toFixed(1)}%), blended=${finalAlphaPartial} (${(finalAlphaPartial/totalMasked*100).toFixed(1)}%)`);
              console.log(`[PIPELINE DIAG] Post-composite skin: ${finalSkin}/${totalMasked} (${(finalSkin/totalMasked*100).toFixed(1)}%), non-skin: ${finalNonSkin} (${(finalNonSkin/totalMasked*100).toFixed(1)}%)`);
            }
          }

          // Graduated blur outside mask edge to soften residue
          const BLUR_EXTEND = featherRadius;
          if (BLUR_EXTEND > 0) {
            const blurredCanvas = document.createElement('canvas');
            blurredCanvas.width = width;
            blurredCanvas.height = height;
            const bCtx = blurredCanvas.getContext('2d');
            bCtx.filter = 'blur(4px)';
            bCtx.drawImage(outCanvas, 0, 0);
            bCtx.filter = 'none';

            const sharpData = outCanvas.getContext('2d').getImageData(0, 0, width, height);
            const blurData = bCtx.getImageData(0, 0, width, height);
            const sp = sharpData.data;
            const bp = blurData.data;

            // For pixels outside the dilated mask but within BLUR_EXTEND, blend sharp→blurred
            for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                if (dilated[idx]) continue; // inside mask — already composited

                // Find distance to nearest mask pixel (fast: check within BLUR_EXTEND)
                let minD2 = (BLUR_EXTEND + 1) * (BLUR_EXTEND + 1);
                for (let dy = -BLUR_EXTEND; dy <= BLUR_EXTEND && minD2 > 1; dy++) {
                  for (let dx = -BLUR_EXTEND; dx <= BLUR_EXTEND; dx++) {
                    const ny = y + dy, nx = x + dx;
                    if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
                    if (dilated[ny * width + nx]) {
                      const d2 = dx * dx + dy * dy;
                      if (d2 < minD2) minD2 = d2;
                    }
                  }
                }
                const dist = Math.sqrt(minD2);
                if (dist >= BLUR_EXTEND) continue;

                // Blend: close to mask = more blur, far = sharp original
                const t = 1 - dist / BLUR_EXTEND;
                const blurAlpha = t * t; // quadratic falloff
                const pi = idx * 4;
                sp[pi]     = Math.round(sp[pi]     * (1 - blurAlpha) + bp[pi]     * blurAlpha);
                sp[pi + 1] = Math.round(sp[pi + 1] * (1 - blurAlpha) + bp[pi + 1] * blurAlpha);
                sp[pi + 2] = Math.round(sp[pi + 2] * (1 - blurAlpha) + bp[pi + 2] * blurAlpha);
              }
            }
            outCanvas.getContext('2d').putImageData(sharpData, 0, 0);
            console.log(`[PIPELINE] Applied graduated blur (${BLUR_EXTEND}px) outside mask`);
          }

          current = outCanvas;

          // Update source for multi-pass workflow
          const updatedSrc = document.createElement('canvas');
          updatedSrc.width = width;
          updatedSrc.height = height;
          updatedSrc.getContext('2d').drawImage(outCanvas, 0, 0);
          strippedCanvasRef.current = updatedSrc;
          console.log('[PIPELINE] Source updated for next inpaint pass');

          // Save training pair with refined mask (fire-and-forget, never blocks UI)
          saveTrainingPair(src, refinedCount > 0 ? refinedTattooMask : customTattooMask, subjectName).then(id => {
            console.log(`[PIPELINE] Training pair saved (id=${id})`);
          }).catch(err => {
            console.warn('[PIPELINE] Training pair save failed:', err);
          });
        } catch (err) {
          console.error('[PIPELINE] Custom mask inpainting failed:', err);
        }
      }
    }

    // Save inpainted result (before face blur) so ReviewScreen can re-composite
    const inpaintedCopy = document.createElement('canvas');
    inpaintedCopy.width = current.width;
    inpaintedCopy.height = current.height;
    inpaintedCopy.getContext('2d').drawImage(current, 0, 0);
    inpaintedCanvasRef.current = inpaintedCopy;

    // Apply face blur (detect + blur in one step, only if enabled)
    if (faceBlur) {
      try {
        if (onProgress) onProgress('Detecting faces...');
        const faces = await detect(current);
        console.log(`[PIPELINE] Detected ${faces.length} face(s) for blur`);
        if (faces.length > 0) {
          // Save detections so ReviewScreen can re-blur when settings change
          setDetections(faces);
          setDetectionToggles(faces.map(() => true));
          const faceMask = createFaceMask(
            current.width, current.height,
            faces, faces.map(() => true)
          );
          current = applyMaskedBlur(current, faceMask, blurSettings.mode, blurSettings.strength, faces);
        }
      } catch (err) {
        console.warn('[PIPELINE] Face detection failed:', err.message);
      }
    }

    outputCanvasRef.current = current;
  }, [strippedCanvasRef, maskCanvasRef, outputCanvasRef, inpaintedCanvasRef, blurSettings, detect, setDetections, setDetectionToggles]);

  return { runPipeline, recomposite, recompositeWithCustomMask };
}
