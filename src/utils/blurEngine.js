/**
 * Stack Blur - O(n) blur algorithm by Mario Klingemann
 * Much faster than true Gaussian for large radii.
 */

const MAX_BLUR_RADIUS = 254;
const PIXELATE_MIN_BLOCK = 2;
const BLACKBAR_HEIGHT_MIN = 0.08;
const BLACKBAR_HEIGHT_RANGE = 0.35;
const BLACKBAR_EYE_Y_RATIO = 0.28;
const BLACKBAR_X_EXTEND = 0.05;
const BLACKBAR_WIDTH_EXTEND = 1.1;
const FACE_BOX_EXPAND = 1.1;
const MASK_ALPHA_THRESHOLD = 128;

const MUL_TABLE = [
  512,512,456,512,328,456,335,512,405,328,271,456,388,335,292,512,
  454,405,364,328,298,271,496,456,420,388,360,335,312,292,273,512,
  482,454,428,405,383,364,345,328,312,298,284,271,259,496,475,456,
  437,420,404,388,374,360,347,335,323,312,302,292,282,273,265,512,
  497,482,468,454,441,428,417,405,394,383,373,364,354,345,337,328,
  320,312,305,298,291,284,278,271,265,259,507,496,485,475,465,456,
  446,437,428,420,412,404,396,388,381,374,367,360,354,347,341,335,
  329,323,318,312,307,302,297,292,287,282,278,273,269,265,261,512,
  505,497,489,482,475,468,461,454,447,441,435,428,422,417,411,405,
  399,394,389,383,378,373,368,364,359,354,350,345,341,337,332,328,
  324,320,316,312,309,305,301,298,294,291,287,284,281,278,274,271,
  268,265,262,259,257,507,501,496,491,485,480,475,470,465,460,456,
  451,446,442,437,433,428,424,420,416,412,408,404,400,396,392,388,
  385,381,377,374,370,367,363,360,357,354,350,347,344,341,338,335,
  332,329,326,323,320,318,315,312,310,307,304,302,299,297,294,292,
  289,287,285,282,280,278,275,273,271,269,267,265,263,261,259
];

const SHG_TABLE = [
  9,11,12,13,13,14,14,15,15,15,15,16,16,16,16,17,
  17,17,17,17,17,17,18,18,18,18,18,18,18,18,18,19,
  19,19,19,19,19,19,19,19,19,19,19,19,19,20,20,20,
  20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,21,
  21,21,21,21,21,21,21,21,21,21,21,21,21,21,21,21,
  21,21,21,21,21,21,21,21,21,21,22,22,22,22,22,22,
  22,22,22,22,22,22,22,22,22,22,22,22,22,22,22,22,
  22,22,22,22,22,22,22,22,22,22,22,22,22,22,22,23,
  23,23,23,23,23,23,23,23,23,23,23,23,23,23,23,23,
  23,23,23,23,23,23,23,23,23,23,23,23,23,23,23,23,
  23,23,23,23,23,23,23,23,23,23,23,23,23,23,23,23,
  23,23,23,23,23,24,24,24,24,24,24,24,24,24,24,24,
  24,24,24,24,24,24,24,24,24,24,24,24,24,24,24,24,
  24,24,24,24,24,24,24,24,24,24,24,24,24,24,24,24,
  24,24,24,24,24,24,24,24,24,24,24,24,24,24,24,24,
  24,24,24,24,24,24,24,24,24,24,24,24,24,24,24
];

export function stackBlur(imageData, radius) {
  if (radius < 1) return imageData;
  radius = Math.min(radius, MAX_BLUR_RADIUS);

  const { width, height } = imageData;
  const pixels = imageData.data;
  const wm = width - 1;
  const hm = height - 1;
  const div = 2 * radius + 1;
  const mulSum = MUL_TABLE[radius];
  const shgSum = SHG_TABLE[radius];

  const rbs = new Int32Array(div);
  const gbs = new Int32Array(div);
  const bbs = new Int32Array(div);

  let rSum, gSum, bSum, rInSum, gInSum, bInSum, rOutSum, gOutSum, bOutSum;
  let p, stackStart, stackEnd;
  let yi = 0;

  for (let y = 0; y < height; y++) {
    rInSum = gInSum = bInSum = rSum = gSum = bSum = rOutSum = gOutSum = bOutSum = 0;

    for (let i = -radius; i <= radius; i++) {
      p = (yi + Math.min(wm, Math.max(i, 0))) * 4;
      const stackIdx = i + radius;
      rbs[stackIdx] = pixels[p];
      gbs[stackIdx] = pixels[p + 1];
      bbs[stackIdx] = pixels[p + 2];
      const rbs_i = Math.abs(i);
      const w = radius + 1 - rbs_i;
      rSum += pixels[p] * w;
      gSum += pixels[p + 1] * w;
      bSum += pixels[p + 2] * w;
      if (i > 0) {
        rInSum += pixels[p];
        gInSum += pixels[p + 1];
        bInSum += pixels[p + 2];
      } else {
        rOutSum += pixels[p];
        gOutSum += pixels[p + 1];
        bOutSum += pixels[p + 2];
      }
    }

    stackStart = radius;

    for (let x = 0; x < width; x++) {
      p = (yi + x) * 4;
      pixels[p] = (rSum * mulSum) >>> shgSum;
      pixels[p + 1] = (gSum * mulSum) >>> shgSum;
      pixels[p + 2] = (bSum * mulSum) >>> shgSum;

      rSum -= rOutSum;
      gSum -= gOutSum;
      bSum -= bOutSum;

      stackEnd = (stackStart - radius + div) % div;
      rOutSum -= rbs[stackEnd];
      gOutSum -= gbs[stackEnd];
      bOutSum -= bbs[stackEnd];

      p = (yi + Math.min(x + radius + 1, wm)) * 4;
      rbs[stackEnd] = pixels[p];
      gbs[stackEnd] = pixels[p + 1];
      bbs[stackEnd] = pixels[p + 2];

      rInSum += pixels[p];
      gInSum += pixels[p + 1];
      bInSum += pixels[p + 2];
      rSum += rInSum;
      gSum += gInSum;
      bSum += bInSum;

      stackStart = (stackStart + 1) % div;
      const startVal = stackStart;
      rOutSum += rbs[startVal];
      gOutSum += gbs[startVal];
      bOutSum += bbs[startVal];
      rInSum -= rbs[startVal];
      gInSum -= gbs[startVal];
      bInSum -= bbs[startVal];
    }
    yi += width;
  }

  for (let x = 0; x < width; x++) {
    rInSum = gInSum = bInSum = rSum = gSum = bSum = rOutSum = gOutSum = bOutSum = 0;

    let yp = -radius * width;

    for (let i = -radius; i <= radius; i++) {
      const yi2 = Math.max(0, yp) + x;
      p = yi2 * 4;
      const stackIdx = i + radius;
      rbs[stackIdx] = pixels[p];
      gbs[stackIdx] = pixels[p + 1];
      bbs[stackIdx] = pixels[p + 2];
      const w = radius + 1 - Math.abs(i);
      rSum += pixels[p] * w;
      gSum += pixels[p + 1] * w;
      bSum += pixels[p + 2] * w;
      if (i > 0) {
        rInSum += pixels[p];
        gInSum += pixels[p + 1];
        bInSum += pixels[p + 2];
      } else {
        rOutSum += pixels[p];
        gOutSum += pixels[p + 1];
        bOutSum += pixels[p + 2];
      }
      if (i < hm) yp += width;
    }

    let yi3 = x;
    stackStart = radius;

    for (let y = 0; y < height; y++) {
      p = yi3 * 4;
      pixels[p] = (rSum * mulSum) >>> shgSum;
      pixels[p + 1] = (gSum * mulSum) >>> shgSum;
      pixels[p + 2] = (bSum * mulSum) >>> shgSum;

      rSum -= rOutSum;
      gSum -= gOutSum;
      bSum -= bOutSum;

      stackEnd = (stackStart - radius + div) % div;
      rOutSum -= rbs[stackEnd];
      gOutSum -= gbs[stackEnd];
      bOutSum -= bbs[stackEnd];

      p = (Math.min(y + radius + 1, hm) * width + x) * 4;
      rbs[stackEnd] = pixels[p];
      gbs[stackEnd] = pixels[p + 1];
      bbs[stackEnd] = pixels[p + 2];

      rInSum += pixels[p];
      gInSum += pixels[p + 1];
      bInSum += pixels[p + 2];
      rSum += rInSum;
      gSum += gInSum;
      bSum += bInSum;

      stackStart = (stackStart + 1) % div;
      rOutSum += rbs[stackStart];
      gOutSum += gbs[stackStart];
      bOutSum += bbs[stackStart];
      rInSum -= rbs[stackStart];
      gInSum -= gbs[stackStart];
      bInSum -= bbs[stackStart];

      yi3 += width;
    }
  }

  return imageData;
}

export function pixelate(imageData, blockSize) {
  if (blockSize < 2) return imageData;
  const { width, height, data } = imageData;

  for (let y = 0; y < height; y += blockSize) {
    for (let x = 0; x < width; x += blockSize) {
      let r = 0, g = 0, b = 0, count = 0;
      const bw = Math.min(blockSize, width - x);
      const bh = Math.min(blockSize, height - y);

      for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
          const i = ((y + by) * width + (x + bx)) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          count++;
        }
      }

      r = Math.round(r / count);
      g = Math.round(g / count);
      b = Math.round(b / count);

      for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
          const i = ((y + by) * width + (x + bx)) * 4;
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
        }
      }
    }
  }

  return imageData;
}

export function blackBar(imageData) {
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
    data[i + 3] = 255;
  }
  return imageData;
}

/**
 * Applies blur/pixelation only where the mask is white.
 * sourceCanvas: original clean image
 * maskCanvas: white = blur, black/transparent = keep original
 * mode: 'gaussian' | 'pixelate' | 'blackbar'
 * strength: blur radius or block size (for blackbar: controls bar height %)
 * detections: optional array of face detections (used for blackbar eye positioning)
 * Returns a new canvas with the composited result.
 */
export function applyMaskedBlur(sourceCanvas, maskCanvas, mode = 'gaussian', strength = 20, detections = null) {
  const { width, height } = sourceCanvas;
  const outCanvas = document.createElement('canvas');
  outCanvas.width = width;
  outCanvas.height = height;
  const outCtx = outCanvas.getContext('2d');

  // Draw original
  outCtx.drawImage(sourceCanvas, 0, 0);

  // Black bar mode. Merge detection bars into the mask-alpha pipeline instead
  // of drawing them directly on outCanvas, so the pixel blend below operates
  // on TRUE original pixels. Drawing bars with fillRect and then reading the
  // canvas back would leave manual brush strokes compositing against already
  // blackened pixels — visually harmless today, but semantically wrong and
  // fragile to any future change in the blend formula.
  if (mode === 'blackbar') {
    const combinedMaskCanvas = document.createElement('canvas');
    combinedMaskCanvas.width = width;
    combinedMaskCanvas.height = height;
    const combinedMaskCtx = combinedMaskCanvas.getContext('2d');

    // Start with the manual brush mask (alpha channel carries the paint).
    combinedMaskCtx.drawImage(maskCanvas, 0, 0);

    // Union detection bars into the mask at alpha 255.
    if (detections && detections.length > 0) {
      combinedMaskCtx.fillStyle = 'rgba(255, 255, 255, 1)';
      for (const det of detections) {
        if (det.type === 'tattoo') continue;
        const x = det.topLeft[0];
        const y = det.topLeft[1];
        const fw = det.bottomRight[0] - x;
        const fh = det.bottomRight[1] - y;

        // Bar spans full face width, centered on eye region (~25-45% from top)
        // Strength controls bar height: 5=thin, 60=covers most of face
        const barHeightRatio = BLACKBAR_HEIGHT_MIN + (strength / 60) * BLACKBAR_HEIGHT_RANGE;
        const barH = fh * barHeightRatio;
        const eyeY = y + fh * BLACKBAR_EYE_Y_RATIO;
        const barY = eyeY - barH / 2;

        // Extend bar slightly past face edges for the classic look
        const barX = x - fw * BLACKBAR_X_EXTEND;
        const barW = fw * BLACKBAR_WIDTH_EXTEND;

        combinedMaskCtx.fillRect(barX, barY, barW, barH);
      }
    }

    // Read the ORIGINAL pixels (outCanvas still only has the source image
    // drawn on it) and the combined mask, then blend toward black per pixel.
    const outData = outCtx.getImageData(0, 0, width, height);
    const maskData = combinedMaskCtx.getImageData(0, 0, width, height);
    const od = outData.data;
    const md = maskData.data;
    for (let i = 0; i < od.length; i += 4) {
      const a = md[i + 3];
      if (a > 0) {
        const t = a / 255;
        od[i] = Math.round(od[i] * (1 - t));
        od[i + 1] = Math.round(od[i + 1] * (1 - t));
        od[i + 2] = Math.round(od[i + 2] * (1 - t));
      }
    }
    outCtx.putImageData(outData, 0, 0);

    return outCanvas;
  }

  const originalData = outCtx.getImageData(0, 0, width, height);

  // Create blurred version
  const blurCanvas = document.createElement('canvas');
  blurCanvas.width = width;
  blurCanvas.height = height;
  const blurCtx = blurCanvas.getContext('2d');
  blurCtx.drawImage(sourceCanvas, 0, 0);
  const blurData = blurCtx.getImageData(0, 0, width, height);

  if (mode === 'gaussian') {
    stackBlur(blurData, Math.round(strength));
  } else if (mode === 'pixelate') {
    pixelate(blurData, Math.max(PIXELATE_MIN_BLOCK, Math.round(strength / 2)));
  }

  // Read mask
  const maskCtx = maskCanvas.getContext('2d');
  const maskData = maskCtx.getImageData(0, 0, width, height);

  // Composite: where mask is white (alpha > 128), use blurred; else keep original
  const out = originalData.data;
  const blur = blurData.data;
  const mask = maskData.data;

  for (let i = 0; i < out.length; i += 4) {
    const maskAlpha = mask[i + 3];
    if (maskAlpha > 0) {
      // Blend based on mask alpha for soft edges
      const t = maskAlpha / 255;
      out[i] = Math.round(out[i] * (1 - t) + blur[i] * t);
      out[i + 1] = Math.round(out[i + 1] * (1 - t) + blur[i + 1] * t);
      out[i + 2] = Math.round(out[i + 2] * (1 - t) + blur[i + 2] * t);
    }
  }

  outCtx.putImageData(originalData, 0, 0);
  return outCanvas;
}
