import { useCallback } from 'react';
import { diagLog, diagSpan } from '../utils/perfDiagnostics';
import { selectBackend } from '../utils/tfBackend';
import { createRetryableLoader } from '../utils/retryableLoader';
import wasmUrl from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm?url';
import wasmSimdUrl from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm?url';
import wasmThreadedSimdUrl from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-threaded-simd.wasm?url';

// BlazeFace resizes its input to 128×128 internally, so detail above ~2048px
// is wasted. Feeding a full 12–24MP canvas to TF.js spikes memory and can
// exceed iOS WebGL's max texture size (~4096px), which fails the call and
// trips the reload-retry loop. We detect on a downscaled copy and scale the
// resulting boxes back to source coordinates.
const MAX_DETECT_DIM = 2048;

const BLAZEFACE_MAX_FACES = 20;
const BLAZEFACE_SCORE_THRESHOLD = 0.9;
const NMS_IOU_THRESHOLD = 0.3;
const TILE_SIZE_RATIO = 0.6;
const ELLIPSE_CONTOUR_POINTS = 36;
// If the full-image pass already returns a face at this confidence or higher,
// we skip the 4 tile passes entirely. Tiles exist to catch small / distant
// faces that disappear at BlazeFace's 128×128 internal input — but when the
// user's subject is clearly in frame, tiles are 4× wasted inference.
const DETECT_FAST_PATH_PROBABILITY = 0.97;

// TF.js backends, in order of preference.
//
// WASM first: the WebGL backend compiles every BlazeFace shader on the main
// thread the first time it runs — measured at 7–9 s of frozen UI per page
// load (independent of image size, since BlazeFace works at 128×128), and it
// has to be redone whenever the browser drops the WebGL context, which mobile
// browsers do to backgrounded pages. WASM has no shaders to compile (first
// detection ~0.2 s on the same machine) and no GPU context to lose. WebGL and
// CPU remain as fallbacks for browsers where WASM can't start.
//
// The .wasm binaries are emitted as hashed /assets/ files via `?url`, so they
// get the same immutable caching + service-worker handling as the JS chunks.
// Only the variant the browser supports is ever fetched.
const BACKENDS = [
  {
    name: 'wasm',
    load: async () => {
      const { setWasmPaths } = await import('@tensorflow/tfjs-backend-wasm');
      setWasmPaths({
        'tfjs-backend-wasm.wasm': wasmUrl,
        'tfjs-backend-wasm-simd.wasm': wasmSimdUrl,
        'tfjs-backend-wasm-threaded-simd.wasm': wasmThreadedSimdUrl,
      });
    },
  },
  { name: 'webgl', load: () => import('@tensorflow/tfjs-backend-webgl') },
  { name: 'cpu', load: () => import('@tensorflow/tfjs-backend-cpu') },
];

// The BlazeFace model (manifest + one weights file, ~466 KB) is served from our
// own origin — see public/models/blazeface-v1/README.md. The package's default
// is a runtime download from tfhub.dev → kaggle.com → a signed Google Cloud
// Storage URL, which meant a third-party request on every cold load, no
// offline face detection, and outright failures when that redirect chain
// answered without CORS headers.
const BLAZEFACE_MODEL_URL = `${import.meta.env.BASE_URL}models/blazeface-v1/model.json`;

// TF.js and BlazeFace are lazy-loaded on first detect() call to keep the
// initial bundle small (~1.3 MB of TF.js stays out of the main chunk).
let tf = null;
let model = null;

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
  modelLoader.reset();
}

// Vite HMR — dispose the cached BlazeFace model before the module is
// replaced so each dev reload doesn't leak another WebGL context's worth
// of textures. Production bundles have no HMR, so this is a no-op there.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeModel();
  });
}

// A failed load (e.g. a dropped connection mid-download) is NOT cached — the
// next detection tries again, instead of face detection staying broken
// until the page is reloaded.
const modelLoader = createRetryableLoader(() => loadBlazeFace().catch((err) => {
  // Diagnostics (?diag=1): a failed load would otherwise leave no trace.
  diagLog('model-load-failed', { error: String(err?.message || err).slice(0, 80) });
  throw err;
}));

async function loadBlazeFace() {
  const endLoad = diagSpan('model-load');
  // Phase marks for the diagnostics entry: which part of a slow load was
  // slow — our code chunks, backend start-up, or the weights download.
  const phase = [performance.now()];
  // Dynamic imports — Vite code-splits these into separate chunks. Fetch
  // them in PARALLEL via Promise.all instead of sequentially, since none of
  // them depend on the others at import time. The backend self-registers
  // into the tf namespace once loaded; blazeface is independent of tf-core
  // at module-load time (only uses it at runtime inside .load()). Cuts
  // cold-start face-detect time by 1-3s on slow networks. Only the
  // PREFERRED backend is fetched up front — selectBackend() pulls the
  // fallbacks' chunks on demand, so most sessions never download WebGL.
  const [tfModule, blazefaceModule] = await Promise.all([
    import('@tensorflow/tfjs-core'),
    import('@tensorflow-models/blazeface'),
    BACKENDS[0].load().catch(() => {}), // selectBackend retries + reports
  ]);
  tf = tfModule;
  const blazeface = blazefaceModule;
  phase.push(performance.now());

  const backend = await selectBackend(tf, BACKENDS);
  console.log('[FaceDetect] TF.js backend:', backend);
  phase.push(performance.now());
  model = await blazeface.load({
    maxFaces: BLAZEFACE_MAX_FACES,
    scoreThreshold: BLAZEFACE_SCORE_THRESHOLD,
    modelUrl: BLAZEFACE_MODEL_URL,
  });
  console.log(`[FaceDetect] BlazeFace loaded (threshold=${BLAZEFACE_SCORE_THRESHOLD}, maxFaces=${BLAZEFACE_MAX_FACES})`);
  phase.push(performance.now());
  endLoad({
    backend: tf.getBackend(),
    importMs: Math.round(phase[1] - phase[0]),
    backendMs: Math.round(phase[2] - phase[1]),
    weightsMs: Math.round(phase[3] - phase[2]),
  });
  return model;
}

const loadModel = () => modelLoader.load();

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

  // Fast path — if the full-image pass found at least one high-confidence face,
  // skip the tiled passes. Saves 4× inference cost in the common case (subject
  // is clearly in frame); tiles still run when the full pass came back empty
  // or only found low-confidence detections (likely a small distant face).
  if (raw.some(r => r.probability >= DETECT_FAST_PATH_PROBABILITY)) {
    console.log(`[FaceDetect] Fast path — ${raw.length} detection(s) at ≥${DETECT_FAST_PATH_PROBABILITY} confidence, skipping tiles`);
    return nms(raw, NMS_IOU_THRESHOLD);
  }

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

  try {
    for (const [tx, ty] of tiles) {
      tileCtx.drawImage(canvas, tx, ty, tileW, tileH, 0, 0, tileW, tileH);
      // Per-tile timeout prevents a hung WebGL context from blocking forever.
      const tilePreds = await Promise.race([
        faceModel.estimateFaces(tileCanvas, false),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Tile detection timed out')), 10000)
        ),
      ]);
      addPredictions(tilePreds, tx, ty);
    }
  } finally {
    // Free tile canvas even if a tile throws (e.g. WebGL context loss)
    tileCanvas.width = 0;
    tileCanvas.height = 0;
  }

  console.log(`[FaceDetect] ${raw.length} raw detections (1 full + ${tiles.length} tiles) → NMS`);
  return nms(raw, 0.3);
}

// --- Hook ---

export function useFaceDetection() {
  const detect = useCallback(async (sourceCanvas) => {
    let face = await loadModel();

    // Detect on a downscaled copy (see MAX_DETECT_DIM). `inv` scales the
    // resulting coordinates back into source space.
    const { width: sw, height: sh } = sourceCanvas;
    const longest = Math.max(sw, sh);
    const ds = longest > MAX_DETECT_DIM ? MAX_DETECT_DIM / longest : 1;
    let detectCanvas = sourceCanvas;
    if (ds < 1) {
      detectCanvas = document.createElement('canvas');
      detectCanvas.width = Math.max(1, Math.round(sw * ds));
      detectCanvas.height = Math.max(1, Math.round(sh * ds));
      detectCanvas.getContext('2d').drawImage(sourceCanvas, 0, 0, detectCanvas.width, detectCanvas.height);
    }
    const inv = ds < 1 ? 1 / ds : 1;

    // Diagnostics (?diag=1): the first detection after a page load — or after
    // the browser drops the WebGL context — recompiles every shader on the
    // main thread, so this span is where a multi-second freeze shows up.
    const endDetect = diagSpan('detect', { w: detectCanvas.width, h: detectCanvas.height });
    try {
      let predictions;
      try {
        predictions = await detectMultiScale(face, detectCanvas);
      } catch (err) {
        diagLog('detect-retry', { error: String(err?.message || err).slice(0, 80) });
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
        predictions = await detectMultiScale(face, detectCanvas);
      }

      endDetect({ faces: predictions.length });
      return predictions.map((pred) => {
        // Scale boxes/landmarks from detect-canvas space back to source space.
        const topLeft = [pred.topLeft[0] * inv, pred.topLeft[1] * inv];
        const bottomRight = [pred.bottomRight[0] * inv, pred.bottomRight[1] * inv];

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
          keypoints: pred.landmarks ? pred.landmarks.map((p) => [p[0] * inv, p[1] * inv]) : null,
          segData: null,
        };
      });
    } finally {
      if (ds < 1) { detectCanvas.width = 0; detectCanvas.height = 0; }
    }
  }, []);

  return { detect };
}
