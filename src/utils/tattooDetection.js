/**
 * Tattoo detection using a YOLOv8 ONNX model.
 *
 * The model expects 640x640 RGB input and outputs bounding boxes
 * with class scores. We run NMS and scale boxes back to original
 * image coordinates.
 */
import * as ort from 'onnxruntime-web';

let session = null;
let sessionLoading = null;
const MODEL_URL = '/models/tattoo-detector.onnx';
const INPUT_SIZE = 640;
const CONFIDENCE_THRESHOLD = 0.35;
const IOU_THRESHOLD = 0.45;

async function loadModel() {
  if (session) return session;
  if (sessionLoading) return sessionLoading;

  sessionLoading = (async () => {
    try {
      session = await ort.InferenceSession.create(MODEL_URL, {
        executionProviders: ['wasm'],
      });
    } catch {
      session = await ort.InferenceSession.create(MODEL_URL, {
        executionProviders: ['wasm'],
      });
    }
    sessionLoading = null;
    return session;
  })();

  return sessionLoading;
}

/**
 * Preprocess canvas to model input tensor.
 * Resizes to 640x640, normalizes to 0-1, converts to NCHW format.
 */
function preprocess(sourceCanvas) {
  const resizeCanvas = document.createElement('canvas');
  resizeCanvas.width = INPUT_SIZE;
  resizeCanvas.height = INPUT_SIZE;
  const ctx = resizeCanvas.getContext('2d');

  // Letterbox resize — maintain aspect ratio with padding
  const scale = Math.min(INPUT_SIZE / sourceCanvas.width, INPUT_SIZE / sourceCanvas.height);
  const newW = Math.round(sourceCanvas.width * scale);
  const newH = Math.round(sourceCanvas.height * scale);
  const padX = (INPUT_SIZE - newW) / 2;
  const padY = (INPUT_SIZE - newH) / 2;

  ctx.fillStyle = '#808080'; // gray padding
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(sourceCanvas, padX, padY, newW, newH);

  const imageData = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const { data } = imageData;

  // Convert to float32 NCHW format [1, 3, 640, 640], normalized 0-1
  const float32Data = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const channelSize = INPUT_SIZE * INPUT_SIZE;

  for (let i = 0; i < channelSize; i++) {
    const pi = i * 4;
    float32Data[i] = data[pi] / 255;                    // R
    float32Data[channelSize + i] = data[pi + 1] / 255;  // G
    float32Data[2 * channelSize + i] = data[pi + 2] / 255; // B
  }

  return {
    tensor: new ort.Tensor('float32', float32Data, [1, 3, INPUT_SIZE, INPUT_SIZE]),
    scale,
    padX,
    padY,
  };
}

/**
 * IoU (Intersection over Union) for NMS
 */
function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter);
}

/**
 * Non-Maximum Suppression
 */
function nms(boxes, scores, iouThreshold) {
  const indices = scores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.i);

  const keep = [];
  const suppressed = new Set();

  for (const idx of indices) {
    if (suppressed.has(idx)) continue;
    keep.push(idx);

    for (const other of indices) {
      if (suppressed.has(other) || other === idx) continue;
      if (iou(boxes[idx], boxes[other]) > iouThreshold) {
        suppressed.add(other);
      }
    }
  }

  return keep;
}

/**
 * Parse YOLOv8 output tensor.
 * YOLOv8 output shape: [1, 5, 8400] where 5 = x,y,w,h + 1 class score
 * (transposed from the older [1, 8400, 5] format)
 */
function parseOutput(output, scale, padX, padY, origW, origH) {
  const data = output.data;
  const [, dims, numBoxes] = output.dims;

  const boxes = [];
  const scores = [];

  for (let i = 0; i < numBoxes; i++) {
    // YOLOv8 output format: each column is [cx, cy, w, h, class_scores...]
    const cx = data[0 * numBoxes + i];
    const cy = data[1 * numBoxes + i];
    const w = data[2 * numBoxes + i];
    const h = data[3 * numBoxes + i];

    // Class score (single class: tattoo)
    const score = data[4 * numBoxes + i];

    if (score < CONFIDENCE_THRESHOLD) continue;

    // Convert from letterboxed coords to original image coords
    const x1 = (cx - w / 2 - padX) / scale;
    const y1 = (cy - h / 2 - padY) / scale;
    const x2 = (cx + w / 2 - padX) / scale;
    const y2 = (cy + h / 2 - padY) / scale;

    // Clamp to image bounds
    boxes.push([
      Math.max(0, x1),
      Math.max(0, y1),
      Math.min(origW, x2),
      Math.min(origH, y2),
    ]);
    scores.push(score);
  }

  // Apply NMS
  const keepIndices = nms(boxes, scores, IOU_THRESHOLD);

  return keepIndices.map((idx) => ({
    type: 'tattoo',
    topLeft: [boxes[idx][0], boxes[idx][1]],
    bottomRight: [boxes[idx][2], boxes[idx][3]],
    probability: scores[idx],
  }));
}

/**
 * Detect tattoos in the given canvas using the ONNX model.
 * Returns an array of detection objects compatible with the pipeline.
 */
export async function detectTattoos(sourceCanvas, segData, faceDetections) {
  try {
    const model = await loadModel();

    const { tensor, scale, padX, padY } = preprocess(sourceCanvas);

    // Get the model's input name
    const inputName = model.inputNames[0];
    const feeds = { [inputName]: tensor };

    const results = await model.run(feeds);
    const outputName = model.outputNames[0];
    const output = results[outputName];

    const detections = parseOutput(
      output,
      scale,
      padX,
      padY,
      sourceCanvas.width,
      sourceCanvas.height
    );

    // Attach segData to each detection for mask generation
    return detections.map((det) => ({
      ...det,
      segData: segData || null,
    }));
  } catch (err) {
    console.warn('Tattoo detection model not available, skipping:', err.message);
    return [];
  }
}
