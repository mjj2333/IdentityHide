import JSZip from 'jszip';
import { fileToCanvas, downscaleToMegapixels, canvasToBlob, capToMaxDimension } from './imageHelpers';
import { getMaxWorkingDimension } from './platform';
import { applyMaskedBlur, stackBlur, migrateBlurSettings, drawRegionMask } from './blurEngine';
import { extractMetadata } from './metadataExtractor';
import {
  uploadImage,
  uploadMask,
  queueAndWait,
  downloadOutputImage,
  prewarmFluxModels,
} from './comfyuiApi';
import { buildTattooRemovalWorkflow, TATTOO_ONLY_OUTPUT_NODE_ID } from './comfyuiWorkflows';

const MASK_ALPHA_THRESHOLD = 128;

/**
 * Check whether a canvas has any alpha > threshold pixels (i.e. the user
 * painted something). Returns false for null/empty canvases. Walks the full
 * ImageData once; at 1 MP this is ~4 MB scanned, typically under 10 ms.
 */
export function hasPaintedPixels(canvas) {
  if (!canvas || !canvas.width || !canvas.height) return false;
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > MASK_ALPHA_THRESHOLD) return true;
  }
  return false;
}

const THUMBNAIL_SIZE = 400;

/**
 * Create a thumbnail canvas from a source canvas.
 */
export function createThumbnail(sourceCanvas) {
  const { width, height } = sourceCanvas;
  const aspect = width / height;
  let tw, th;
  if (aspect > 1) {
    tw = THUMBNAIL_SIZE;
    th = Math.round(THUMBNAIL_SIZE / aspect);
  } else {
    th = THUMBNAIL_SIZE;
    tw = Math.round(THUMBNAIL_SIZE * aspect);
  }
  const c = document.createElement('canvas');
  c.width = tw;
  c.height = th;
  c.getContext('2d').drawImage(sourceCanvas, 0, 0, tw, th);
  return c;
}

/**
 * Convert a canvas to a blob URL. Much lighter than toDataURL — the image
 * bytes live in the blob store instead of a ~1 MB base64 string per thumbnail.
 * Callers must URL.revokeObjectURL() when done.
 */
export function canvasToBlobUrl(canvas) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(URL.createObjectURL(blob)), 'image/jpeg', 0.85);
  });
}

/**
 * Load a File into a working-resolution canvas + thumbnail, and summarize
 * the original EXIF so the UI can surface what was stripped. Canvas
 * re-encoding drops all metadata silently; the summary lets the grid tell
 * the user which photos had location data before it was removed.
 * Returns { strippedCanvas, thumbnailCanvas, thumbnailUrl, exifSummary }.
 */
export async function prepareImage(file, tierMP = 1) {
  // Extract metadata in parallel with the canvas decode — they both read
  // the same file but different parts, so running concurrently saves a
  // small amount of latency per image.
  const [fullCanvas, metadata] = await Promise.all([
    fileToCanvas(file),
    extractMetadata(file).catch(() => null),
  ]);
  const { canvas: tierCanvas } = downscaleToMegapixels(fullCanvas, tierMP);
  // Free full-res canvas (batch doesn't need it — we re-export at working resolution)
  fullCanvas.width = 0;
  fullCanvas.height = 0;
  // Cap the editing canvas on memory-constrained devices (same reason as the
  // single-image path — keeps iOS from running out of canvas memory).
  const cap = capToMaxDimension(tierCanvas, getMaxWorkingDimension());
  const strippedCanvas = cap.canvas;
  if (cap.scaled) {
    tierCanvas.width = 0;
    tierCanvas.height = 0;
  }
  const thumbnailCanvas = createThumbnail(strippedCanvas);
  const thumbnailUrl = await canvasToBlobUrl(thumbnailCanvas);
  // `hadLocation` is only meaningful for JPEGs — extractMetadata returns
  // readable:false for PNG/HEIC/WebP, so we can't confirm presence either
  // way for those. The UI treats unreadable as "no detected location".
  const exifSummary = {
    readable: metadata?.readable !== false,
    hadLocation: !!metadata?.gps,
  };
  return { strippedCanvas, thumbnailCanvas, thumbnailUrl, exifSummary };
}

/**
 * Build a white-on-transparent mask from face detections.
 * Matches the buildPreviewMask logic in MaskEditorScreen/BatchEditorScreen.
 * faceBlurCanvas (if provided) contributes freehand brush strokes — merged
 * before feather so feathering softens strokes the same way it softens
 * detection shapes.
 */
export function buildFaceMask(detections, width, height, mode, feather = 0, faceBlurCanvas = null) {
  const mask = document.createElement('canvas');
  mask.width = width;
  mask.height = height;
  const ctx = mask.getContext('2d');

  if (mode !== 'blackbar') {
    for (const det of detections) {
      if (det.kind === 'sticker') continue; // stickers aren't blur regions
      drawRegionMask(ctx, det);
    }
  }

  // Merge freehand brush strokes (applies in every mode — for blackbar they
  // become additional blackened regions via applyMaskedBlur's combined mask).
  if (faceBlurCanvas) {
    ctx.drawImage(faceBlurCanvas, 0, 0);
  }

  // Apply feather (blur the mask's alpha channel)
  if (feather > 0 && mode !== 'blackbar') {
    const imgData = ctx.getImageData(0, 0, width, height);
    const d = imgData.data;
    // Copy alpha → RGB, blur RGB, copy blurred R → alpha
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i + 3]; d[i + 1] = d[i + 3]; d[i + 2] = d[i + 3];
    }
    stackBlur(imgData, feather);
    for (let i = 0; i < d.length; i += 4) {
      d[i + 3] = d[i]; d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
  }

  return mask;
}

/**
 * Apply face blur to a single image entry using the provided base canvas.
 * `baseCanvas` is the canvas to blur *into* — in the face-only path this is
 * `imageEntry.strippedCanvas`, in the combined path it's the inpainted output
 * from ComfyUI (after VAE-size normalisation).
 *
 * Honors per-image overrides saved by BatchEditorScreen: blurSettings,
 * localFeather, editDetections, and faceBlurCanvas (freehand strokes).
 * Returns the blurred output canvas, or a clone of `baseCanvas` when there
 * are no regions to blur.
 */
export function applyFaceBlurToCanvas(baseCanvas, imageEntry, globalBlurSettings, globalFeather) {
  const { detections, editDetections, blurSettings: perImageSettings, localFeather, faceBlurCanvas } = imageEntry;
  const dets = editDetections || detections || [];
  const settings = migrateBlurSettings(perImageSettings || globalBlurSettings);
  const feather = localFeather != null ? localFeather : globalFeather;

  // Short-circuit only when there's truly nothing to blur (no detections AND
  // no freehand strokes). An edited image with only freehand paint has
  // dets.length === 0 but still needs the full mask pipeline.
  if (dets.length === 0 && !faceBlurCanvas) {
    const c = document.createElement('canvas');
    c.width = baseCanvas.width;
    c.height = baseCanvas.height;
    c.getContext('2d').drawImage(baseCanvas, 0, 0);
    return c;
  }

  const { mode, strength } = settings;
  const { width, height } = baseCanvas;
  // If the freehand face-blur mask was painted at the stripped-canvas size but
  // we're applying against a differently-sized inpainted canvas, resize once
  // so mask coordinates align. ComfyUI rounds to VAE-friendly dimensions; the
  // mask needs to follow.
  let faceBrushCanvas = faceBlurCanvas;
  if (faceBlurCanvas && (faceBlurCanvas.width !== width || faceBlurCanvas.height !== height)) {
    const resized = document.createElement('canvas');
    resized.width = width;
    resized.height = height;
    resized.getContext('2d').drawImage(faceBlurCanvas, 0, 0, width, height);
    faceBrushCanvas = resized;
  }
  const stickerEnabled = !!settings.stickerEnabled; // freehand color-brush flag
  const wantBlur = mode === 'gaussian' || mode === 'pixelate';
  const blurDets = dets.filter(d => d.kind !== 'sticker');
  const stickerObjects = dets.filter(d => d.kind === 'sticker');
  const blurMask = wantBlur ? buildFaceMask(blurDets, width, height, mode, feather, faceBrushCanvas) : null;
  // Freehand color strokes only (no detection shapes).
  const freehandStickerMask = stickerEnabled ? buildFaceMask([], width, height, 'blackbar', 0, faceBrushCanvas) : null;
  return applyMaskedBlur(
    baseCanvas, blurMask, wantBlur ? mode : 'none', strength,
    stickerObjects, freehandStickerMask, settings.barColor || '#000000',
  );
}

/**
 * Apply face blur to a single image entry.
 * Thin wrapper around applyFaceBlurToCanvas for the face-only path where the
 * base canvas is always `imageEntry.strippedCanvas`. Preserved for existing
 * callers (processBatchFaceBlur).
 */
export function applyBatchBlur(imageEntry, globalBlurSettings, globalFeather) {
  return applyFaceBlurToCanvas(imageEntry.strippedCanvas, imageEntry, globalBlurSettings, globalFeather);
}

/**
 * Process all batch images with face blur.
 * onProgress(completed, total, result) is called after each image with the
 * per-image result (`{ id, outputCanvas, error }`) so the caller can commit
 * state incrementally. Committing incrementally means an abort mid-batch
 * preserves the work already done rather than discarding everything.
 * Yields to the event loop between images so the UI stays responsive and
 * the caller can abort mid-batch via `signal`.
 */
export async function processBatchFaceBlur(images, globalBlurSettings, globalFeather, onProgress, signal) {
  const results = [];
  for (let i = 0; i < images.length; i++) {
    if (signal?.aborted) {
      throw new DOMException('Batch processing cancelled', 'AbortError');
    }
    const img = images[i];
    let result;
    // Skip images that failed detection — they have no strippedCanvas to process
    if (img.status === 'error') {
      result = { id: img.id, outputCanvas: null, error: img.error || 'Skipped (detection failed)' };
    } else {
      try {
        const outputCanvas = applyBatchBlur(img, globalBlurSettings, globalFeather);
        result = { id: img.id, outputCanvas, error: null };
      } catch (err) {
        result = { id: img.id, outputCanvas: null, error: err.message };
      }
    }
    results.push(result);
    onProgress?.(i + 1, images.length, result);
    // Yield between images so the cancel button can fire and the progress
    // bar can repaint. Without this, the whole batch runs in one tick and
    // the UI is frozen for the duration.
    if (i < images.length - 1) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return results;
}

/**
 * Run ComfyUI tattoo inpainting on one image and return the inpainted canvas.
 * Mirrors useImagePipeline.recompositeWithCustomMask's inpaint leg, but takes
 * a batch image entry and the batch-level abort signal. Progress is piped
 * through onStepProgress(fraction, message) for the caller's use.
 */
async function runComfyUIInpaint(imageEntry, tierMP, signal, onStepProgress) {
  const { strippedCanvas: src, tattooMaskCanvas } = imageEntry;
  if (!src) throw new Error('No source canvas to inpaint');

  // Tier governs ComfyUI processing resolution. If the strippedCanvas is
  // larger than the tier cap, downscale the source+mask for upload so
  // ComfyUI processes at the intended megapixel budget. We always upscale
  // the result back to strippedCanvas dims so the face-blur step (which uses
  // detection coordinates in strippedCanvas space) stays aligned.
  const { canvas: uploadSrc } = downscaleToMegapixels(src, tierMP);
  let uploadMaskCanvas;
  if (uploadSrc === src && tattooMaskCanvas.width === src.width && tattooMaskCanvas.height === src.height) {
    uploadMaskCanvas = tattooMaskCanvas;
  } else {
    const m = document.createElement('canvas');
    m.width = uploadSrc.width;
    m.height = uploadSrc.height;
    m.getContext('2d').drawImage(tattooMaskCanvas, 0, 0, uploadSrc.width, uploadSrc.height);
    uploadMaskCanvas = m;
  }

  onStepProgress(0, 'Uploading image');
  const imageName = await uploadImage(uploadSrc, `batch_${imageEntry.id}_img.png`, { signal });

  onStepProgress(0.05, 'Uploading mask');
  const maskName = await uploadMask(uploadMaskCanvas, `batch_${imageEntry.id}_mask.png`, { signal });

  onStepProgress(0.1, 'Starting inpaint');
  const workflow = buildTattooRemovalWorkflow(imageName, maskName);
  const history = await queueAndWait(workflow, {
    signal,
    onProgress: (p) => {
      // ComfyUI WS gives fraction 0.1..0.9 over the KSampler. Remap to the
      // caller's 0.1..0.85 window so "downloading" gets its own stretch.
      const frac = 0.1 + (p.fraction ?? 0) * 0.75;
      onStepProgress(frac, p.message || 'Processing');
    },
  });

  onStepProgress(0.85, 'Downloading result');
  let result = await downloadOutputImage(history, TATTOO_ONLY_OUTPUT_NODE_ID, { signal });

  // Free the downscaled upload canvas if we allocated one.
  if (uploadSrc !== src) { uploadSrc.width = 0; uploadSrc.height = 0; }

  // Normalize back to strippedCanvas dimensions. Two cases both end here:
  //   1. VAE rounding inside ComfyUI returned an off-by-a-few-pixels result.
  //   2. We downscaled for Quick tier and need to upscale the output back.
  if (result.width !== src.width || result.height !== src.height) {
    const resized = document.createElement('canvas');
    resized.width = src.width;
    resized.height = src.height;
    const rctx = resized.getContext('2d');
    rctx.imageSmoothingEnabled = true;
    rctx.imageSmoothingQuality = 'high';
    rctx.drawImage(result, 0, 0, src.width, src.height);
    result.width = 0; result.height = 0;
    result = resized;
  }

  onStepProgress(0.95, 'Applying face blur');
  return result;
}

/**
 * Process a batch with combined tattoo inpainting + face blur per image.
 *
 * Per image flow:
 *   1. If `tattooMaskCanvas` has painted pixels → ComfyUI inpaint
 *      (otherwise clone strippedCanvas as working base).
 *   2. Apply face blur on top using saved per-image settings (editDetections,
 *      faceBlurCanvas, blurSettings, localFeather) or the global defaults.
 *   3. Emit progress so the UI can show two-level status (batch + per-image step).
 *
 * Sequential (one ComfyUI job at a time) to avoid overwhelming the tunnel.
 * Per-image errors are caught and recorded; the batch continues with the
 * next image. A batch-level abort (signal) throws out of the loop.
 *
 * `onProgress(completed, total, detail)` is called at each stage with:
 *   detail = { id, stage: 'inpainting'|'blurring'|'done'|'skipped',
 *              stageFraction: 0..1, outputCanvas?, error? }
 */
export async function processBatchCombined(images, globalBlurSettings, globalFeather, tierMP, onProgress, signal) {
  const hasAnyTattoo = images.some(img => hasPaintedPixels(img.tattooMaskCanvas));
  if (hasAnyTattoo) {
    // Fire-and-forget — cached in VRAM for the first real job.
    prewarmFluxModels().catch(() => {});
  }

  const results = [];
  for (let i = 0; i < images.length; i++) {
    if (signal?.aborted) {
      throw new DOMException('Batch processing cancelled', 'AbortError');
    }
    const img = images[i];
    let result;

    // Images that failed detection have no strippedCanvas — skip.
    if (img.status === 'error' || !img.strippedCanvas) {
      result = { id: img.id, outputCanvas: null, error: img.error || 'Skipped (no image data)' };
      results.push(result);
      onProgress?.(i + 1, images.length, { id: img.id, stage: 'skipped', stageFraction: 1, ...result });
      if (i < images.length - 1) await new Promise(r => setTimeout(r, 0));
      continue;
    }

    try {
      const wantsInpaint = hasPaintedPixels(img.tattooMaskCanvas);

      let baseCanvas;
      if (wantsInpaint) {
        baseCanvas = await runComfyUIInpaint(img, tierMP, signal, (frac, message) => {
          onProgress?.(i, images.length, {
            id: img.id,
            stage: 'inpainting',
            stageFraction: frac,
            message,
          });
        });
      } else {
        // Clone strippedCanvas as the working base (face blur needs a canvas
        // it can safely overwrite without affecting the stored working copy).
        baseCanvas = document.createElement('canvas');
        baseCanvas.width = img.strippedCanvas.width;
        baseCanvas.height = img.strippedCanvas.height;
        baseCanvas.getContext('2d').drawImage(img.strippedCanvas, 0, 0);
        onProgress?.(i, images.length, { id: img.id, stage: 'blurring', stageFraction: 0 });
      }

      const outputCanvas = applyFaceBlurToCanvas(baseCanvas, img, globalBlurSettings, globalFeather);
      // If applyFaceBlurToCanvas returned a new canvas (it does when there's
      // anything to blur), free the intermediate `baseCanvas` bitmap to keep
      // peak memory bounded across a 20-image batch.
      if (outputCanvas !== baseCanvas) {
        baseCanvas.width = 0;
        baseCanvas.height = 0;
      }

      result = { id: img.id, outputCanvas, error: null };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      console.warn('[Batch] image failed:', img.file?.name, err);
      result = { id: img.id, outputCanvas: null, error: err.message || 'Processing failed' };
    }

    results.push(result);
    onProgress?.(i + 1, images.length, { id: img.id, stage: 'done', stageFraction: 1, ...result });
    if (i < images.length - 1) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return results;
}

/**
 * Build a zip file from processed batch images.
 * Returns a Blob of the zip.
 */
export async function buildBatchZip(images, format = 'png', quality = 0.92) {
  const zip = new JSZip();
  const mimeType = format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
  const ext = format === 'jpg' ? 'jpg' : format;

  const usedNames = new Set();
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    // Require outputCanvas — falling back to strippedCanvas would silently
    // export the unblurred source for any image that slipped past
    // processBatchFaceBlur. Callers must ensure outputCanvas is populated
    // (see ensureOutputCanvas in BatchExportScreen).
    if (!img.outputCanvas) {
      console.warn('[buildBatchZip] skipping image without outputCanvas:', img.file?.name);
      continue;
    }
    const blob = await canvasToBlob(img.outputCanvas, mimeType, quality);
    // Strip extension, sanitize to ASCII-safe characters for broad ZIP compatibility
    const rawStem = (img.file?.name?.replace(/\.[^.]+$/, '') || `image_${i + 1}`)
      .replace(/[^\w\s\-().]/g, '_')  // replace non-ASCII / unsafe chars
      .replace(/\s+/g, '_')           // spaces to underscores
      .replace(/_{2,}/g, '_')         // collapse runs
      .replace(/^_|_$/g, '')          // trim leading/trailing
      || `image_${i + 1}`;
    // Deduplicate: if the base name is taken, find the first numeric suffix
    // that isn't. Using `i + 1` (the old approach) could collide with a
    // user-supplied filename — e.g., uploading ["photo_3.png", "photo.png",
    // "photo.png"] would emit photo_3_protected.png twice because the
    // fallback blindly used i+1=3 without checking.
    let name = `${rawStem}_protected.${ext}`;
    if (usedNames.has(name)) {
      let counter = 2;
      let candidate;
      do {
        candidate = `${rawStem}_${counter}_protected.${ext}`;
        counter++;
      } while (usedNames.has(candidate));
      name = candidate;
    }
    usedNames.add(name);
    zip.file(name, blob);
  }

  return zip.generateAsync({ type: 'blob' });
}
