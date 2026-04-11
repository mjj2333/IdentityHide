import { useCallback } from 'react';
import { usePipeline } from '../context/PipelineContext';
import { extractMetadata } from '../utils/metadataExtractor';
import { fileToCanvas, downscaleToMegapixels, upscaleCanvas } from '../utils/imageHelpers';
import { uploadImage, uploadMask, queueAndWait, downloadOutputImage, prewarmFluxModels } from '../utils/comfyuiApi';
import { buildTattooRemovalWorkflow, TATTOO_ONLY_OUTPUT_NODE_ID } from '../utils/comfyuiWorkflows';
import { useFaceDetection } from './useFaceDetection';
import { applyMaskedBlur } from '../utils/blurEngine';
import { track } from '../utils/analytics';

// Default working-resolution megapixel count. Callers (post-upload modal)
// typically pass an explicit tierMP; this constant only applies to legacy
// callers that haven't been updated yet. Matches the old hardcoded value
// so behaviour is identical when tierMP is omitted.
const DEFAULT_WORKING_MP = 1;
const MASK_ALPHA_THRESHOLD = 128;
const FACE_BOX_EXPAND = 1.1;

export function useImagePipeline() {
  const {
    setMetadata,
    setDetections,
    setStatus,
    setError,
    setWarning,
    blurSettings,
    strippedCanvasRef,
    originalCanvasRef,
    outputCanvasRef,
    tattooMaskCanvasRef,
    inpaintedCanvasRef,
    fullResCanvasRef,
    workingScaleRef,
    setScreen,
  } = usePipeline();

  const { detect } = useFaceDetection();

  const runPipeline = useCallback(async (file, tierMP = DEFAULT_WORKING_MP) => {
    try {
      setStatus('stripping');
      setError(null);

      // Release previous canvas bitmap memory before allocating new ones
      for (const ref of [fullResCanvasRef, strippedCanvasRef, originalCanvasRef, outputCanvasRef, tattooMaskCanvasRef, inpaintedCanvasRef]) {
        if (ref.current) { ref.current.width = 0; ref.current.height = 0; }
      }

      const meta = await extractMetadata(file);
      setMetadata(meta);

      // Strip metadata by re-encoding through canvas
      const cleanCanvas = await fileToCanvas(file);

      // Store full-res original for export upscaling
      fullResCanvasRef.current = cleanCanvas;

      // Downscale to the user-selected working resolution (1/2/4/12 MP tier)
      const { canvas: workCanvas, scale: wScale } = downscaleToMegapixels(cleanCanvas, tierMP);
      workingScaleRef.current = wScale;
      strippedCanvasRef.current = workCanvas;

      // Full-res copy for before/after comparison
      const origCopy = document.createElement('canvas');
      origCopy.width = cleanCanvas.width;
      origCopy.height = cleanCanvas.height;
      origCopy.getContext('2d').drawImage(cleanCanvas, 0, 0);
      originalCanvasRef.current = origCopy;

      // Working-res output
      const output = document.createElement('canvas');
      output.width = workCanvas.width;
      output.height = workCanvas.height;
      output.getContext('2d').drawImage(workCanvas, 0, 0);
      outputCanvasRef.current = output;

      // Empty tattoo mask at working resolution
      const emptyMask = document.createElement('canvas');
      emptyMask.width = workCanvas.width;
      emptyMask.height = workCanvas.height;
      tattooMaskCanvasRef.current = emptyMask;

      setStatus('ready');
      setScreen('mask-edit');
      track('mask_editor_entered', { width: workCanvas.width, height: workCanvas.height });

      // Fire-and-forget: detect faces while user paints mask
      detect(workCanvas).then(faceDetections => {
        setDetections(faceDetections);
      }).catch(e => {
        console.warn('[Pipeline] Early face detection failed:', e.message);
        setWarning('Auto face detection failed — you can still paint face-blur regions manually.');
      });

      // Fire-and-forget: load Flux models into VRAM while user paints mask
      prewarmFluxModels();
    } catch (err) {
      console.error('Pipeline error:', err);
      setError(err.message || 'Processing failed');
      setStatus('error');
    }
  }, [
    detect, setDetections,
    setMetadata, setStatus, setError, setWarning, setScreen,
    fullResCanvasRef, strippedCanvasRef, originalCanvasRef, outputCanvasRef,
    tattooMaskCanvasRef, inpaintedCanvasRef, workingScaleRef,
  ]);

  /**
   * Send 1MP image + mask to ComfyUI for Flux inpainting.
   * Then optionally run client-side BlazeFace detection + blur.
   * All processing at 1MP — upscale happens at export.
   */
  const recompositeWithCustomMask = useCallback(async (customTattooMask, subjectName = 'default', { faceBlur = true, blurRadius = 30, blurMode = 'gaussian', onProgress = null, signal = null } = {}) => {
    const src = strippedCanvasRef.current;
    if (!src) return;

    // Throws if the caller has aborted. Called at every async checkpoint so a
    // late abort (e.g. user clicks cancel after queueAndWait resolves) doesn't
    // continue downloading or running face detection.
    const checkAborted = () => {
      if (signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
    };

    // Check if there are any masked pixels
    let hasMask = false;
    if (customTattooMask) {
      const tmCtx = customTattooMask.getContext('2d');
      const tmData = tmCtx.getImageData(0, 0, customTattooMask.width, customTattooMask.height);
      for (let i = 0; i < tmData.data.length; i += 4) {
        if (tmData.data[i + 3] > MASK_ALPHA_THRESHOLD) { hasMask = true; break; }
      }
      if (!hasMask && !faceBlur) {
        console.log('[PIPELINE] No mask pixels and no face blur — setting base only');
      }
    }

    let resultCanvas = null;

    try {
      // --- Step A: ComfyUI tattoo inpainting at 1MP ---
      if (hasMask) {
        checkAborted();
        if (onProgress) onProgress({ message: 'Uploading image...', fraction: 0.05 });
        const imageName = await uploadImage(src, 'identityhide_input.png');
        checkAborted();
        console.log(`[PIPELINE] Uploaded image: ${imageName} (${src.width}x${src.height})`);

        // Resize mask to exactly match source dimensions (they can diverge after multi-pass)
        let maskToUpload = customTattooMask;
        if (customTattooMask.width !== src.width || customTattooMask.height !== src.height) {
          console.log(`[PIPELINE] Resizing mask ${customTattooMask.width}x${customTattooMask.height} → ${src.width}x${src.height}`);
          const resized = document.createElement('canvas');
          resized.width = src.width;
          resized.height = src.height;
          resized.getContext('2d').drawImage(customTattooMask, 0, 0, src.width, src.height);
          maskToUpload = resized;
        }

        if (onProgress) onProgress({ message: 'Uploading mask...', fraction: 0.1 });
        const maskName = await uploadMask(maskToUpload, 'identityhide_mask.png');
        console.log(`[PIPELINE] Uploaded mask: ${maskName}`);
        checkAborted();

        if (onProgress) onProgress({ message: 'Starting tattoo removal...', fraction: 0.15 });
        const workflow = buildTattooRemovalWorkflow(imageName, maskName);

        const history = await queueAndWait(workflow, {
          signal,
          onProgress: (p) => {
            if (onProgress) onProgress({
              message: p.message || 'Processing...',
              fraction: 0.15 + (p.fraction ?? 0) * 0.6,
            });
          },
        });

        checkAborted();
        if (onProgress) onProgress({ message: 'Downloading result...', fraction: 0.75 });
        resultCanvas = await downloadOutputImage(history, TATTOO_ONLY_OUTPUT_NODE_ID, { signal });
        checkAborted();
        track('comfyui_completed', { width: resultCanvas.width, height: resultCanvas.height });
        console.log(`[PIPELINE] Inpaint result: ${resultCanvas.width}x${resultCanvas.height}`);

        // ComfyUI may return a slightly different resolution (VAE rounding).
        // Resize back to match our working resolution so everything stays aligned.
        if (resultCanvas.width !== src.width || resultCanvas.height !== src.height) {
          console.log(`[PIPELINE] Resizing result ${resultCanvas.width}x${resultCanvas.height} → ${src.width}x${src.height}`);
          const resized = document.createElement('canvas');
          resized.width = src.width;
          resized.height = src.height;
          resized.getContext('2d').drawImage(resultCanvas, 0, 0, src.width, src.height);
          resultCanvas = resized;
        }
      } else {
        // No tattoo mask — copy source
        resultCanvas = document.createElement('canvas');
        resultCanvas.width = src.width;
        resultCanvas.height = src.height;
        resultCanvas.getContext('2d').drawImage(src, 0, 0);
      }

      // Store clean inpainted result BEFORE face blur (used as base for re-blur)
      inpaintedCanvasRef.current = resultCanvas;

      // --- Step B: Client-side BlazeFace detection + blur (at 1MP) ---
      console.log(`[PIPELINE] faceBlur=${faceBlur}, resultCanvas=${resultCanvas.width}x${resultCanvas.height}`);
      if (faceBlur) {
        checkAborted();
        if (onProgress) onProgress({ message: 'Detecting faces...', fraction: 0.8 });
        const faceDetections = await detect(resultCanvas);
        checkAborted();
        console.log(`[PIPELINE] Detected ${faceDetections.length} faces`);
        setDetections(faceDetections);

        if (faceDetections.length > 0) {
          if (onProgress) onProgress({ message: 'Blurring faces...', fraction: 0.9 });

          const faceMask = document.createElement('canvas');
          faceMask.width = resultCanvas.width;
          faceMask.height = resultCanvas.height;
          const fmCtx = faceMask.getContext('2d');

          for (const det of faceDetections) {
            const cx = (det.topLeft[0] + det.bottomRight[0]) / 2;
            const cy = (det.topLeft[1] + det.bottomRight[1]) / 2;
            const rx = (det.bottomRight[0] - det.topLeft[0]) / 2 * FACE_BOX_EXPAND;
            const ry = (det.bottomRight[1] - det.topLeft[1]) / 2 * FACE_BOX_EXPAND;

            fmCtx.fillStyle = 'white';
            fmCtx.beginPath();
            fmCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
            fmCtx.fill();
          }

          resultCanvas = applyMaskedBlur(resultCanvas, faceMask, blurMode, blurRadius, faceDetections);
        }
      }

      outputCanvasRef.current = resultCanvas;

      // Update strippedCanvasRef for multi-pass workflow (use clean inpainted, not blurred)
      const clean = inpaintedCanvasRef.current;
      const copy = document.createElement('canvas');
      copy.width = clean.width;
      copy.height = clean.height;
      copy.getContext('2d').drawImage(clean, 0, 0);
      strippedCanvasRef.current = copy;

      if (onProgress) onProgress({ message: 'Done!', fraction: 1.0 });
    } catch (err) {
      track('comfyui_failed', { error: err.message });
      console.error('[PIPELINE] Processing failed:', err);
      throw err;
    }
  }, [detect, setDetections, strippedCanvasRef, outputCanvasRef, inpaintedCanvasRef]);

  /**
   * Re-run face blur on current output with new settings (no ComfyUI round-trip).
   */
  const reblurFaces = useCallback(async (mode = 'gaussian', strength = 20, detections = []) => {
    const base = inpaintedCanvasRef.current;
    if (!base || detections.length === 0) return;

    const faceMask = document.createElement('canvas');
    faceMask.width = base.width;
    faceMask.height = base.height;
    const fmCtx = faceMask.getContext('2d');

    for (const det of detections) {
      const cx = (det.topLeft[0] + det.bottomRight[0]) / 2;
      const cy = (det.topLeft[1] + det.bottomRight[1]) / 2;
      const rx = (det.bottomRight[0] - det.topLeft[0]) / 2 * FACE_BOX_EXPAND;
      const ry = (det.bottomRight[1] - det.topLeft[1]) / 2 * FACE_BOX_EXPAND;

      fmCtx.fillStyle = 'white';
      fmCtx.beginPath();
      fmCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      fmCtx.fill();
    }

    const blurred = applyMaskedBlur(base, faceMask, mode, strength, detections);
    outputCanvasRef.current = blurred;
  }, [inpaintedCanvasRef, outputCanvasRef]);

  /**
   * Build full-resolution output for export.
   * Upscales the 1MP processed result back to original dimensions.
   */
  const buildFullResOutput = useCallback(async () => {
    const processed = outputCanvasRef.current || inpaintedCanvasRef.current;
    const original = fullResCanvasRef.current;

    if (!processed || !original) return processed;

    // If already at original resolution (scale was 1), return as-is
    if (processed.width === original.width && processed.height === original.height) {
      return processed;
    }

    // Upscale 1MP result to original dimensions
    console.log(`[EXPORT] Upscaling ${processed.width}x${processed.height} → ${original.width}x${original.height}`);
    return upscaleCanvas(processed, original.width, original.height);
  }, [fullResCanvasRef, inpaintedCanvasRef, outputCanvasRef]);

  return { runPipeline, recompositeWithCustomMask, reblurFaces, buildFullResOutput };
}
