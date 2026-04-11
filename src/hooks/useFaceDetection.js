import { useCallback } from 'react';

const BLAZEFACE_MAX_FACES = 20;
const BLAZEFACE_SCORE_THRESHOLD = 0.9;
const NMS_IOU_THRESHOLD = 0.3;
const TILE_SIZE_RATIO = 0.6;
const ELLIPSE_CONTOUR_POINTS = 36;

// TF.js and BlazeFace are lazy-loaded on first detect() call to keep the
// initial bundle small (~1.3 MB of TF.js stays out of the main chunk).
let tf = null;
let model = null;
let modelLoading = null;

// Upper bound on WebGL-context-loss reload-and-retry cycles across the lifetime
// of the page. Past this we stop trying to reload and surface the error so a
// persistently broken GPU context can't silently spin forever.
const MAX_MODEL_RELOADS = 3;
let modelReloadCount = 0;

function disposeModel() {
  if (model) {
    try { model.dispose?.(); } catch {}
    model = null;
  }
  modelLoading = null;
}

async function loadModel() {
  if (model) return model;
  if (modelLoading) return modelLoading;
  modelLoading = (async () => {
    // Dynamic imports — Vite will code-split these into a separate chunk
    tf = await import('@tensorflow/tfjs-core');
    await import('@tensorflow/tfjs-backend-webgl');
    await import('@tensorflow/tfjs-backend-cpu');
    const blazeface = await import('@tensorflow-models/blazeface');

    try {
      await tf.setBackend('webgl');
      await tf.ready();
    } catch {
      console.warn('[FaceDetect] WebGL unavailable, falling back to CPU');
      await tf.setBackend('cpu');
      await tf.ready();
    }
    console.log('[FaceDetect] TF.js backend:', tf.getBackend());
    model = await blazeface.load({
      maxFaces: BLAZEFACE_MAX_FACES,
      scoreThreshold: BLAZEFACE_SCORE_THRESHOLD,
    });
    console.log(`[FaceDetect] BlazeFace loaded (threshold=${BLAZEFACE_SCORE_THRESHOLD}, maxFaces=${BLAZEFACE_MAX_FACES})`);
    modelLoading = null;
    return model;
  })();
  return modelLoading;
}

// --- NMS utilities ---

function computeIoU(a, b) {
  const x1 = Math.max(a.topLeft[0], b.topLeft[0]);
  const y1 = Math.max(a.topLeft[1], b.topLeft[1]);
  const x2 = Math.min(a.bottomRight[0], b.bottomRight[0]);
  const y2 = Math.min(a.bottomRight[1], b.bottomRight[1]);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a.bottomRight[0] - a.topLeft[0]) * (a.bottomRight[1] - a.topLeft[1]);
  const areaB = (b.bottomRight[0] - b.topLeft[0]) * (b.bottomRight[1] - b.topLeft[1]);
  const union = areaA + areaB - intersection;
  return union > 0 ? intersection / union : 0;
}

function nms(detections, iouThreshold = NMS_IOU_THRESHOLD) {
  if (detections.length === 0) return [];
  const sorted = [...detections].sort((a, b) => b.probability - a.probability);
  const keep = [];
  const suppressed = new Set();
  for (let i = 0; i < sorted.length; i++) {
    if (suppressed.has(i)) continue;
    keep.push(sorted[i]);
    for (let j = i + 1; j < sorted.length; j++) {
      if (suppressed.has(j)) continue;
      if (computeIoU(sorted[i], sorted[j]) > iouThreshold) {
        suppressed.add(j);
      }
    }
  }
  return keep;
}

// --- Multi-scale tiled detection ---
// BlazeFace internally processes at 128x128, so small faces get lost.
// By splitting into overlapping tiles, each face occupies more of the
// 128x128 internal space, dramatically improving small-face detection.

async function detectMultiScale(faceModel, canvas) {
  const { width, height } = canvas;
  const raw = [];

  function addPredictions(preds, offsetX, offsetY) {
    for (const p of preds) {
      raw.push({
        topLeft: [p.topLeft[0] + offsetX, p.topLeft[1] + offsetY],
        bottomRight: [p.bottomRight[0] + offsetX, p.bottomRight[1] + offsetY],
        probability: p.probability?.[0] ?? p.probability ?? 0.95,
        landmarks: p.landmarks
          ? p.landmarks.map(lm => [lm[0] + offsetX, lm[1] + offsetY])
          : null,
      });
    }
  }

  // Pass 1: full image
  const fullPreds = await faceModel.estimateFaces(canvas, false);
  addPredictions(fullPreds, 0, 0);

  // Pass 2: overlapping 2x2 tiles (60% of image each, 20% overlap)
  const tileW = Math.round(width * TILE_SIZE_RATIO);
  const tileH = Math.round(height * TILE_SIZE_RATIO);
  const stepX = width - tileW;
  const stepY = height - tileH;

  const tiles = [
    [0, 0],
    [stepX, 0],
    [0, stepY],
    [stepX, stepY],
  ];

  const tileCanvas = document.createElement('canvas');
  tileCanvas.width = tileW;
  tileCanvas.height = tileH;
  const tileCtx = tileCanvas.getContext('2d');

  for (const [tx, ty] of tiles) {
    tileCtx.drawImage(canvas, tx, ty, tileW, tileH, 0, 0, tileW, tileH);
    const tilePreds = await faceModel.estimateFaces(tileCanvas, false);
    addPredictions(tilePreds, tx, ty);
  }

  // Free tile canvas
  tileCanvas.width = 0;
  tileCanvas.height = 0;

  console.log(`[FaceDetect] ${raw.length} raw detections (1 full + ${tiles.length} tiles) → NMS`);
  return nms(raw, 0.3);
}

// --- Hook ---

export function useFaceDetection() {
  const detect = useCallback(async (sourceCanvas) => {
    let face = await loadModel();

    let predictions;
    try {
      predictions = await detectMultiScale(face, sourceCanvas);
    } catch (err) {
      // WebGL context loss — dispose stale model, reload, retry once.
      // Capped at MAX_MODEL_RELOADS across the page lifetime.
      if (modelReloadCount >= MAX_MODEL_RELOADS) {
        console.error(`[FaceDetect] Giving up after ${MAX_MODEL_RELOADS} reload attempts:`, err.message);
        throw err;
      }
      modelReloadCount++;
      console.warn(`[FaceDetect] Detection failed, reloading model (attempt ${modelReloadCount}/${MAX_MODEL_RELOADS}):`, err.message);
      disposeModel();
      face = await loadModel();
      predictions = await detectMultiScale(face, sourceCanvas);
    }

    return predictions.map((pred) => {
      const topLeft = pred.topLeft;
      const bottomRight = pred.bottomRight;

      const cx = (topLeft[0] + bottomRight[0]) / 2;
      const cy = (topLeft[1] + bottomRight[1]) / 2;
      const rx = (bottomRight[0] - topLeft[0]) / 2;
      const ry = (bottomRight[1] - topLeft[1]) / 2;

      const contourPoints = ELLIPSE_CONTOUR_POINTS;
      const contour = [];
      for (let i = 0; i < contourPoints; i++) {
        const angle = (i / contourPoints) * 2 * Math.PI;
        contour.push([
          cx + rx * Math.cos(angle),
          cy + ry * Math.sin(angle),
        ]);
      }

      return {
        topLeft,
        bottomRight,
        probability: pred.probability,
        contour,
        keypoints: pred.landmarks || null,
        segData: null,
      };
    });
  }, []);

  return { detect };
}
