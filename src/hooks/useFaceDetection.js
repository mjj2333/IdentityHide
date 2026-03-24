import { useCallback, useRef } from 'react';
// Import only core + WebGL backend (not the full @tensorflow/tfjs which
// may register a WASM backend and compete with ONNX Runtime for Firefox's
// limited WASM executable memory).
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-webgl';
import '@tensorflow/tfjs-backend-cpu';
import * as blazeface from '@tensorflow-models/blazeface';

// Module-level model cache
let model = null;
let modelLoading = null;

async function loadModel() {
  if (model) return model;
  if (modelLoading) return modelLoading;
  modelLoading = (async () => {
    // Use WebGL backend — avoids WASM memory contention with ONNX Runtime.
    // Fall back to CPU if WebGL unavailable (e.g., GPU busy with training).
    try {
      await tf.setBackend('webgl');
      await tf.ready();
    } catch {
      console.warn('[FaceDetect] WebGL unavailable, falling back to CPU');
      await tf.setBackend('cpu');
      await tf.ready();
    }
    console.log('[FaceDetect] TF.js backend:', tf.getBackend());
    model = await blazeface.load();
    console.log('[FaceDetect] BlazeFace loaded');
    modelLoading = null;
    return model;
  })();
  return modelLoading;
}

export function useFaceDetection() {
  const modelsRef = useRef(null);

  const detect = useCallback(async (sourceCanvas) => {
    const face = await loadModel();
    modelsRef.current = { face };

    const predictions = await face.estimateFaces(sourceCanvas, false);

    return predictions.map((pred) => {
      // BlazeFace returns topLeft/bottomRight as [x, y] arrays
      // and landmarks: [rightEye, leftEye, nose, mouth, rightEar, leftEar]
      const topLeft = [pred.topLeft[0], pred.topLeft[1]];
      const bottomRight = [pred.bottomRight[0], pred.bottomRight[1]];

      // Build a simple face oval contour from the bounding box
      const cx = (topLeft[0] + bottomRight[0]) / 2;
      const cy = (topLeft[1] + bottomRight[1]) / 2;
      const rx = (bottomRight[0] - topLeft[0]) / 2;
      const ry = (bottomRight[1] - topLeft[1]) / 2;

      // Generate ellipse contour points for mask generation
      const contourPoints = 36;
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
        probability: pred.probability?.[0] ?? pred.probability ?? 0.95,
        contour,
        keypoints: pred.landmarks || null,
        segData: null, // BlazeFace doesn't provide body segmentation
      };
    });
  }, []);

  return { detect };
}
