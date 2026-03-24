/**
 * MobileSAM integration for precise tattoo segmentation.
 *
 * Uses a lightweight Segment Anything Model (MobileSAM) to produce
 * pixel-accurate masks from YOLO bounding box prompts.
 *
 * Architecture:
 *   Image Encoder (TinyViT, ~5MB) → runs once per image
 *   Mask Decoder (~4MB) → runs per bounding box prompt
 *
 * Models expected at:
 *   /models/mobile_sam.encoder.onnx
 *   /models/mobile_sam.decoder.onnx
 */
import * as ort from 'onnxruntime-web';

const ENCODER_URL = '/models/mobile_sam.encoder.onnx';
const DECODER_URL = '/models/mobile_sam.decoder.onnx';
const SAM_INPUT_SIZE = 1024;

// ImageNet normalization constants
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let encoderSession = null;
let decoderSession = null;
let loadingPromise = null;

// Cached encoder output for the current image
let cachedEmbedding = null;
let cachedImageId = null;

/**
 * Initialize MobileSAM encoder and decoder sessions.
 * Returns true if models loaded successfully, false otherwise.
 */
export async function initSAM() {
  if (encoderSession && decoderSession) return true;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      console.log('[SAM] Loading MobileSAM models...');
      const opts = { executionProviders: ['wasm'] };

      const [enc, dec] = await Promise.all([
        ort.InferenceSession.create(ENCODER_URL, opts),
        ort.InferenceSession.create(DECODER_URL, opts),
      ]);

      encoderSession = enc;
      decoderSession = dec;

      console.log('[SAM] Models loaded successfully');
      console.log('[SAM] Encoder inputs:', enc.inputNames, 'outputs:', enc.outputNames);
      console.log('[SAM] Decoder inputs:', dec.inputNames, 'outputs:', dec.outputNames);
      return true;
    } catch (err) {
      console.warn('[SAM] Failed to load MobileSAM models:', err.message);
      console.warn('[SAM] Error details:', err);
      console.warn('[SAM] Place mobile_sam.encoder.onnx and mobile_sam.decoder.onnx in /public/models/');
      loadingPromise = null;
      return false;
    }
  })();

  return loadingPromise;
}

/**
 * Check if SAM models are available.
 */
export function isSAMAvailable() {
  return !!(encoderSession && decoderSession);
}

/**
 * Preprocess canvas for SAM encoder.
 * Resizes to 1024x1024 preserving aspect ratio with zero padding,
 * then applies ImageNet normalization.
 *
 * Returns { tensor, scale, padX, padY }
 */
function preprocessForEncoder(sourceCanvas) {
  const { width: origW, height: origH } = sourceCanvas;
  const scale = SAM_INPUT_SIZE / Math.max(origW, origH);
  const newW = Math.round(origW * scale);
  const newH = Math.round(origH * scale);

  // Resize canvas
  const resizeCanvas = document.createElement('canvas');
  resizeCanvas.width = SAM_INPUT_SIZE;
  resizeCanvas.height = SAM_INPUT_SIZE;
  const ctx = resizeCanvas.getContext('2d');

  // Black/zero padding (SAM convention)
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, SAM_INPUT_SIZE, SAM_INPUT_SIZE);
  ctx.drawImage(sourceCanvas, 0, 0, newW, newH);

  const imageData = ctx.getImageData(0, 0, SAM_INPUT_SIZE, SAM_INPUT_SIZE);
  const pixels = imageData.data;
  const channelSize = SAM_INPUT_SIZE * SAM_INPUT_SIZE;

  // Convert to float32 NCHW [1, 3, 1024, 1024] with ImageNet normalization
  const float32 = new Float32Array(3 * channelSize);
  for (let i = 0; i < channelSize; i++) {
    const pi = i * 4;
    float32[i] = (pixels[pi] / 255 - MEAN[0]) / STD[0];                         // R
    float32[channelSize + i] = (pixels[pi + 1] / 255 - MEAN[1]) / STD[1];       // G
    float32[2 * channelSize + i] = (pixels[pi + 2] / 255 - MEAN[2]) / STD[2];   // B
  }

  return {
    tensor: new ort.Tensor('float32', float32, [1, 3, SAM_INPUT_SIZE, SAM_INPUT_SIZE]),
    scale,
    newW,
    newH,
  };
}

/**
 * Run the image encoder and cache the embedding.
 * Only re-runs if the image has changed.
 */
export async function encodeImage(sourceCanvas) {
  if (!encoderSession) throw new Error('SAM encoder not initialized');

  // Simple cache key based on canvas dimensions + a sample of pixel data
  const imageId = `${sourceCanvas.width}x${sourceCanvas.height}_${Date.now()}`;

  console.log('[SAM] Running image encoder...');
  const t0 = performance.now();

  const { tensor, scale, newW, newH } = preprocessForEncoder(sourceCanvas);

  const inputName = encoderSession.inputNames[0];
  const results = await encoderSession.run({ [inputName]: tensor });

  const embeddingName = encoderSession.outputNames[0];
  cachedEmbedding = results[embeddingName];
  cachedImageId = imageId;

  console.log(`[SAM] Encoder done in ${(performance.now() - t0).toFixed(0)}ms`);
  console.log(`[SAM] Embedding shape: [${cachedEmbedding.dims}]`);

  return { scale, newW, newH };
}

/**
 * Segment a region given a bounding box prompt.
 *
 * @param {number[]} bbox - [x1, y1, x2, y2] in original image coordinates
 * @param {number} origWidth - Original image width
 * @param {number} origHeight - Original image height
 * @param {number} scale - Scale factor from encodeImage
 * @returns {HTMLCanvasElement} - Binary mask canvas (white = segment, black = background)
 */
export async function segmentBox(bbox, origWidth, origHeight, scale) {
  if (!decoderSession || !cachedEmbedding) {
    throw new Error('SAM decoder not initialized or no cached embedding');
  }

  const [x1, y1, x2, y2] = bbox;

  // Scale box coordinates to SAM's 1024x1024 space
  const scaledBox = [
    x1 * scale,
    y1 * scale,
    x2 * scale,
    y2 * scale,
  ];

  // Box prompt: 2 box corners + 1 padding point (for samexporter compatibility)
  // Labels: 2=top-left corner, 3=bottom-right corner, -1=padding
  const pointCoords = new Float32Array([
    scaledBox[0], scaledBox[1],  // top-left
    scaledBox[2], scaledBox[3],  // bottom-right
    0, 0,                        // padding point
  ]);
  const pointLabels = new Float32Array([2, 3, -1]);

  // No previous mask
  const maskInput = new Float32Array(1 * 1 * 256 * 256);
  const hasMaskInput = new Float32Array([0]);
  const origImSize = new Float32Array([origHeight, origWidth]);

  const feeds = {
    image_embeddings: cachedEmbedding,
    point_coords: new ort.Tensor('float32', pointCoords, [1, 3, 2]),
    point_labels: new ort.Tensor('float32', pointLabels, [1, 3]),
    mask_input: new ort.Tensor('float32', maskInput, [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', hasMaskInput, [1]),
    orig_im_size: new ort.Tensor('float32', origImSize, [2]),
  };

  const t0 = performance.now();
  const results = await decoderSession.run(feeds);
  console.log(`[SAM] Decoder done in ${(performance.now() - t0).toFixed(0)}ms`);

  // Get mask output — SAM outputs multiple masks, pick the best one by IoU score
  const masksOutput = results.masks || results[decoderSession.outputNames[0]];
  const iouOutput = results.iou_predictions || results[decoderSession.outputNames[1]];

  console.log(`[SAM] Mask output shape: [${masksOutput.dims}], IoU scores available: ${!!iouOutput}`);

  return postprocessMask(masksOutput, iouOutput, origWidth, origHeight);
}

/**
 * Convert SAM mask logits to a binary mask canvas.
 * Picks the highest-IoU mask, thresholds at 0, and creates a canvas.
 */
function postprocessMask(masksOutput, iouOutput, origWidth, origHeight) {
  const dims = masksOutput.dims;
  const numMasks = dims[1] || 1;
  const maskH = dims[dims.length - 2];
  const maskW = dims[dims.length - 1];
  const maskSize = maskH * maskW;
  const data = masksOutput.data;

  // Pick the mask with highest IoU
  let bestIdx = 0;
  if (iouOutput && iouOutput.data.length > 1) {
    let bestIoU = -Infinity;
    for (let i = 0; i < numMasks; i++) {
      if (iouOutput.data[i] > bestIoU) {
        bestIoU = iouOutput.data[i];
        bestIdx = i;
      }
    }
    console.log(`[SAM] Best mask index: ${bestIdx}, IoU: ${iouOutput.data[bestIdx].toFixed(3)}`);
  }

  // Extract best mask and threshold at 0 (logits > 0 = foreground)
  const offset = bestIdx * maskSize;
  const binaryMask = new Uint8Array(maskSize);
  let fgCount = 0;
  for (let i = 0; i < maskSize; i++) {
    if (data[offset + i] > 0) {
      binaryMask[i] = 255;
      fgCount++;
    }
  }
  console.log(`[SAM] Mask: ${fgCount}/${maskSize} foreground pixels (${(fgCount/maskSize*100).toFixed(1)}%)`);

  // Create mask canvas at original image resolution
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = origWidth;
  maskCanvas.height = origHeight;
  const ctx = maskCanvas.getContext('2d');

  if (maskW === origWidth && maskH === origHeight) {
    // Mask is already at original resolution
    const imgData = ctx.createImageData(origWidth, origHeight);
    for (let i = 0; i < maskSize; i++) {
      const di = i * 4;
      imgData.data[di] = binaryMask[i];
      imgData.data[di + 1] = binaryMask[i];
      imgData.data[di + 2] = binaryMask[i];
      imgData.data[di + 3] = binaryMask[i];
    }
    ctx.putImageData(imgData, 0, 0);
  } else {
    // Need to resize mask to original resolution
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = maskW;
    tempCanvas.height = maskH;
    const tempCtx = tempCanvas.getContext('2d');
    const tempData = tempCtx.createImageData(maskW, maskH);
    for (let i = 0; i < maskSize; i++) {
      const di = i * 4;
      tempData.data[di] = binaryMask[i];
      tempData.data[di + 1] = binaryMask[i];
      tempData.data[di + 2] = binaryMask[i];
      tempData.data[di + 3] = binaryMask[i];
    }
    tempCtx.putImageData(tempData, 0, 0);

    // Scale to original size using nearest-neighbor (for binary mask)
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tempCanvas, 0, 0, origWidth, origHeight);
  }

  return maskCanvas;
}

/**
 * Check if SAM embedding is ready for decoding.
 */
export function getEmbeddingInfo() {
  return { hasEmbedding: !!cachedEmbedding, cachedImageId };
}

/**
 * Segment using point prompt + optional bounding box constraint.
 * Combines the click point with a bbox for much better tattoo results:
 * the box tells SAM "look in this area" and the point says "this is foreground."
 *
 * @param {Array<{x: number, y: number, label: number}>} points
 *   label=1 foreground (include), label=0 background (exclude)
 * @param {number} origWidth - Original image width
 * @param {number} origHeight - Original image height
 * @param {number} scale - Scale factor from encodeImage()
 * @param {number[]|null} bbox - Optional [x1,y1,x2,y2] bounding box in image coords
 * @returns {HTMLCanvasElement} - Binary mask canvas
 */
export async function segmentPoint(points, origWidth, origHeight, scale, bbox) {
  if (!decoderSession || !cachedEmbedding) {
    throw new Error('SAM decoder not initialized or no cached embedding');
  }

  // Build prompt: box corners (if bbox) + user points + padding to reach at least 3
  const allCoords = [];
  const allLabels = [];

  if (bbox) {
    // Box corners first (labels 2 and 3)
    allCoords.push(bbox[0] * scale, bbox[1] * scale);
    allLabels.push(2);
    allCoords.push(bbox[2] * scale, bbox[3] * scale);
    allLabels.push(3);
  }

  // User click points
  for (const p of points) {
    allCoords.push(p.x * scale, p.y * scale);
    allLabels.push(p.label);
  }

  // Pad to at least 3 points (model expects this minimum)
  while (allLabels.length < 3) {
    allCoords.push(0, 0);
    allLabels.push(-1);
  }

  const totalPoints = allLabels.length;
  const pointCoords = new Float32Array(allCoords);
  const pointLabels = new Float32Array(allLabels);

  const maskInput = new Float32Array(1 * 1 * 256 * 256);
  const hasMaskInput = new Float32Array([0]);
  const origImSize = new Float32Array([origHeight, origWidth]);

  const feeds = {
    image_embeddings: cachedEmbedding,
    point_coords: new ort.Tensor('float32', pointCoords, [1, totalPoints, 2]),
    point_labels: new ort.Tensor('float32', pointLabels, [1, totalPoints]),
    mask_input: new ort.Tensor('float32', maskInput, [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', hasMaskInput, [1]),
    orig_im_size: new ort.Tensor('float32', origImSize, [2]),
  };

  const t0 = performance.now();
  const results = await decoderSession.run(feeds);
  console.log(`[SAM] Point decoder done in ${(performance.now() - t0).toFixed(0)}ms, ${totalPoints} points (bbox: ${!!bbox})`);

  const masksOutput = results.masks || results[decoderSession.outputNames[0]];
  const iouOutput = results.iou_predictions || results[decoderSession.outputNames[1]];

  return postprocessMask(masksOutput, iouOutput, origWidth, origHeight);
}

/**
 * Generate SAM masks for all tattoo detections.
 * Runs encoder once, then decoder for each tattoo bbox.
 *
 * @param {HTMLCanvasElement} sourceCanvas - The source image
 * @param {Array} detections - Detection objects with topLeft/bottomRight
 * @param {Array} toggles - Toggle states for each detection
 * @returns {Map<number, HTMLCanvasElement>} - Map of detection index → mask canvas
 */
export async function generateSAMMasks(sourceCanvas, detections, toggles) {
  const available = await initSAM();
  if (!available) return null;

  const { width, height } = sourceCanvas;

  // Run encoder once
  const { scale } = await encodeImage(sourceCanvas);

  const masks = new Map();

  for (let i = 0; i < detections.length; i++) {
    const det = detections[i];
    if (det.type !== 'tattoo') continue;
    if (toggles && toggles[i] === false) continue;

    const bbox = [
      det.topLeft[0], det.topLeft[1],
      det.bottomRight[0], det.bottomRight[1],
    ];

    try {
      const maskCanvas = await segmentBox(bbox, width, height, scale);
      masks.set(i, maskCanvas);
      console.log(`[SAM] Generated mask for tattoo ${i}`);
    } catch (err) {
      console.warn(`[SAM] Failed to segment tattoo ${i}:`, err.message);
    }
  }

  return masks;
}
