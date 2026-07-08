/**
 * Stack Blur - O(n) blur algorithm by Mario Klingemann
 * Much faster than true Gaussian for large radii.
 */

import { STICKER_PATHS } from './stickerPaths';

const MAX_BLUR_RADIUS = 254;
const PIXELATE_MIN_BLOCK = 2;
const BLACKBAR_HEIGHT_MIN = 0.08;
const BLACKBAR_HEIGHT_RANGE = 0.35;
const BLACKBAR_EYE_Y_RATIO = 0.28;
const BLACKBAR_X_EXTEND = 0.05;
const BLACKBAR_WIDTH_EXTEND = 1.1;
export const FACE_BOX_EXPAND = 1.1;

/**
 * Paint a single blur region into a mask context as solid white. Shape is
 * driven by `det.shape`: 'rect' draws a filled rectangle, anything else
 * (including undefined — auto-detected faces and legacy regions) draws an
 * ellipse. Centralized here so the editor preview, review, export pipeline,
 * and batch processor all render identical geometry. Callers are responsible
 * for skipping sticker-kind objects before calling.
 */
export function drawRegionMask(ctx, det, expand = FACE_BOX_EXPAND) {
  const cx = (det.topLeft[0] + det.bottomRight[0]) / 2;
  const cy = (det.topLeft[1] + det.bottomRight[1]) / 2;
  const rx = (det.bottomRight[0] - det.topLeft[0]) / 2 * expand;
  const ry = (det.bottomRight[1] - det.topLeft[1]) / 2 * expand;
  // Rotation (degrees → radians) around the region's own centre. `angle` is
  // set by the manual-blur Angle slider; auto-detected faces and legacy
  // regions have none, so this is a no-op for them.
  const angle = ((det.angle || 0) * Math.PI) / 180;
  ctx.fillStyle = 'white';
  ctx.beginPath();
  if (det.shape === 'rect') {
    // ctx.rect has no rotation arg, so build the rotated rect via a transform;
    // path points bake in the rotation and survive the restore before fill.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.rect(-rx, -ry, rx * 2, ry * 2);
    ctx.restore();
  } else {
    ctx.ellipse(cx, cy, rx, ry, angle, 0, Math.PI * 2);
  }
  ctx.fill();
}

export const BLUR_MODES = [
  { key: 'gaussian', label: 'Gaussian' },
  { key: 'pixelate', label: 'Pixelate' },
  { key: 'blackbar', label: 'Bar' },
];

/** Lookup map from mode key → display label */
export const BLUR_MODE_LABELS = Object.fromEntries(BLUR_MODES.map(m => [m.key, m.label]));

/**
 * Sticker shapes available in 'blackbar' mode. The "blackbar" engine key is
 * preserved for backward compatibility with saved sessions and analytics
 * events, even though the UI now presents this as the "Stickers" picker.
 * `solid` is a plain rectangle drawn procedurally; every other entry maps
 * to an SVG silhouette in stickerPaths.js.
 */
export const BAR_STYLES = [
  { key: 'solid',           label: 'Black Bar' },
  { key: 'brush',           label: 'Brush Stroke' },
  { key: 'ink-roller-1',    label: 'Ink Roller 1' },
  { key: 'ink-roller-2',    label: 'Ink Roller 2' },
  { key: 'marker-scribble', label: 'Marker Scribble' },
  { key: 'matte-censor',    label: 'Matte Censor' },
];
export const DEFAULT_BAR_STYLE = 'solid';
export const DEFAULT_BAR_COLOR = '#000000';

/**
 * Normalise a persisted blurSettings object to the current model. Older
 * sessions used a single `mode: 'blackbar'` for the sticker effect; the model
 * is now `mode` ('none'|'gaussian'|'pixelate') + an independent `stickerEnabled`
 * flag. Maps legacy blackbar → { mode: 'none', stickerEnabled: true } and fills
 * in the new field for everything else. Returns a new object; input untouched.
 */
export function migrateBlurSettings(s) {
  if (!s || typeof s !== 'object') return s;
  if (s.mode === 'blackbar') {
    return { ...s, mode: 'none', stickerEnabled: true };
  }
  return { stickerEnabled: false, ...s };
}

function parseHexColor(hex) {
  // Accept '#RGB', '#RRGGBB', or rgb()-ish — fall back to black on garbage.
  if (typeof hex !== 'string') return [0, 0, 0];
  let s = hex.trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (s.length !== 6) return [0, 0, 0];
  const n = parseInt(s, 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// Lazy Path2D cache keyed by sticker name. The path strings live in
// stickerPaths.js; we only allocate a Path2D the first time a given
// sticker actually renders. Path2D isn't defined in some non-browser
// runtimes (server-side prerender, unit tests), so guard the lookup
// and fall back to a plain rectangle when it's missing.
const _stickerPathCache = {};
function getStickerForStyle(style) {
  const entry = STICKER_PATHS[style];
  if (!entry) return null;
  if (typeof Path2D === 'undefined') return null;
  if (!_stickerPathCache[style]) {
    _stickerPathCache[style] = new Path2D(entry.d);
  }
  return { vw: entry.vw, vh: entry.vh, path: _stickerPathCache[style] };
}

/**
 * Draws a single detection bar into the combined mask canvas, applying the
 * given style's shape. The mask is greyscale (white = bar) — color and
 * opacity are applied later in the RGB blend pass.
 */
function drawStyledBarToMask(ctx, cx, cy, w, h, angle, style) {
  ctx.save();
  ctx.translate(cx, cy);
  if (angle) ctx.rotate(angle);

  const sticker = getStickerForStyle(style);
  if (sticker) {
    // Scale the sticker's SVG viewBox uniformly into the bar's w×h, then
    // translate so the viewBox centre lines up with the (already rotated)
    // bar centre. evenodd carves out inner holes present in some paths.
    ctx.scale(w / sticker.vw, h / sticker.vh);
    ctx.translate(-sticker.vw / 2, -sticker.vh / 2);
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.fill(sticker.path, 'evenodd');
  } else {
    // 'solid' (the literal Black Bar) and any unknown legacy style — e.g.
    // 'marker' or 'tape' saved from older sessions — render as a plain
    // rectangle. The opacity blend stays at 1.0 for everything.
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.fillRect(-w / 2, -h / 2, w, h);
  }

  ctx.restore();
}
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
 * Applies a blur and/or one-or-more sticker objects, layered blur-then-sticker.
 *
 *   - mode: 'none' | 'gaussian' | 'pixelate' — the BLUR pass over `blurMask`.
 *   - stickerObjects: array of independently-placed stickers, each with its own
 *     box (topLeft/bottomRight), style, color, and barWidth/barLength/barAngle.
 *     Each is stamped CENTERED on its box, on top of the blur.
 *   - freehandStickerMask / freehandStickerColor: the freehand color-brush
 *     strokes (one shared color), also stamped in the sticker pass.
 *
 * sourceCanvas : original clean image
 * blurMask     : where to blur — white = blur (blur-kind regions + freehand
 *                blur strokes). Built by the caller.
 *
 * Returns a new canvas with the composited result.
 */
export function applyMaskedBlur(sourceCanvas, blurMask, mode = 'gaussian', strength = 20, stickerObjects = [], freehandStickerMask = null, freehandStickerColor = '#000000') {
  const { width, height } = sourceCanvas;
  const outCanvas = document.createElement('canvas');
  outCanvas.width = width;
  outCanvas.height = height;
  const outCtx = outCanvas.getContext('2d');

  // Draw original
  outCtx.drawImage(sourceCanvas, 0, 0);

  // PASS 1 — blur the masked region. Writes blurred pixels into outCanvas.
  if ((mode === 'gaussian' || mode === 'pixelate') && blurMask) {
    applyBlurPass(outCanvas, outCtx, sourceCanvas, blurMask, mode, strength, width, height);
  }

  // PASS 2 — stamp stickers on top of (the possibly already-blurred) output.
  const hasStickers = (stickerObjects && stickerObjects.length > 0) || !!freehandStickerMask;
  if (hasStickers) {
    applyStickerPass(outCtx, stickerObjects, freehandStickerMask, freehandStickerColor, width, height);
  }

  return outCanvas;
}

/**
 * Blend `outCtx`'s current pixels toward `colorHex` wherever `maskCanvas` has
 * alpha. Used once per sticker (each its own color) and for freehand strokes.
 * Sticker shapes are fully opaque, so the mask alpha alone controls per-pixel
 * blend strength.
 */
function blendMaskTowardColor(outCtx, maskCanvas, colorHex, width, height) {
  const [tr, tg, tb] = parseHexColor(colorHex);
  const outData = outCtx.getImageData(0, 0, width, height);
  const maskData = maskCanvas.getContext('2d').getImageData(0, 0, width, height);
  const od = outData.data;
  const md = maskData.data;
  for (let i = 0; i < od.length; i += 4) {
    const a = md[i + 3];
    if (a > 0) {
      const t = a / 255;
      od[i] = Math.round(od[i] * (1 - t) + tr * t);
      od[i + 1] = Math.round(od[i + 1] * (1 - t) + tg * t);
      od[i + 2] = Math.round(od[i + 2] * (1 - t) + tb * t);
    }
  }
  outCtx.putImageData(outData, 0, 0);
}

/**
 * Sticker pass. First the freehand color-brush strokes (one color), then each
 * sticker object — its styled shape stamped CENTERED on its own box, sized to
 * barWidth%×barLength% of that box, rotated barAngle, blended toward its OWN
 * color. Reads outCtx as it stands, so it layers over PASS 1's blur.
 */
function applyStickerPass(outCtx, stickerObjects, freehandStickerMask, freehandStickerColor, width, height) {
  if (freehandStickerMask) {
    blendMaskTowardColor(outCtx, freehandStickerMask, freehandStickerColor || DEFAULT_BAR_COLOR, width, height);
  }

  for (const s of (stickerObjects || [])) {
    if (!s || s.type === 'tattoo') continue;
    const x = s.topLeft[0], y = s.topLeft[1];
    const bw = s.bottomRight[0] - x, bh = s.bottomRight[1] - y;
    if (bw <= 0 || bh <= 0) continue;
    const cx = x + bw / 2, cy = y + bh / 2;
    const barH = bh * ((s.barWidth ?? 100) / 100);
    const barW = bw * ((s.barLength ?? 100) / 100);
    const angle = ((s.barAngle || 0) * Math.PI) / 180;
    const style = s.barStyle || DEFAULT_BAR_STYLE;

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = width;
    maskCanvas.height = height;
    drawStyledBarToMask(maskCanvas.getContext('2d'), cx, cy, barW, barH, angle, style);
    blendMaskTowardColor(outCtx, maskCanvas, s.barColor || DEFAULT_BAR_COLOR, width, height);
  }
}

/**
 * Blur pass. Crop-to-mask optimised gaussian / pixelate, compositing the
 * blurred crop back into `outCanvas` across the mask alpha. Operates in place
 * on outCanvas (which already holds the source image).
 */
function applyBlurPass(outCanvas, outCtx, sourceCanvas, maskCanvas, mode, strength, width, height) {
  // Crop-to-mask optimisation. The mask covers a small fraction of the image
  // in the typical face-blur case (~5–15% of canvas area), so running
  // stackBlur over the full source wastes 85–95% of the work on pixels that
  // will be discarded. Instead:
  //   1. Scan the mask for its bbox (pixels with alpha > 0).
  //   2. Pad the bbox by `strength` so stackBlur's read radius stays inside
  //      valid source content — preserves edge behaviour identical to the
  //      full-canvas blur inside the masked region.
  //   3. Crop source + mask to that padded bbox, blur the crop, composite
  //      back into the output canvas only across the bbox.
  // The win scales with (canvas_area / bbox_area); typically 6-8× faster on
  // 1 MP images with default blur strength.
  const maskCtx = maskCanvas.getContext('2d');
  const maskFullData = maskCtx.getImageData(0, 0, width, height);
  const bbox = computeMaskBBox(maskFullData, width, height);

  if (!bbox) {
    // No masked pixels at all — nothing to blur. outCanvas already holds the
    // source; leave it untouched (a sticker pass may still run after this).
    return;
  }

  const padding = mode === 'gaussian' ? Math.ceil(Math.max(1, strength)) + 1 : 0;
  const bx = Math.max(0, bbox.x - padding);
  const by = Math.max(0, bbox.y - padding);
  const bw = Math.min(width, bbox.x + bbox.w + padding) - bx;
  const bh = Math.min(height, bbox.y + bbox.h + padding) - by;

  // Extract and blur the source crop.
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = bw;
  cropCanvas.height = bh;
  const cropCtx = cropCanvas.getContext('2d');
  cropCtx.drawImage(sourceCanvas, bx, by, bw, bh, 0, 0, bw, bh);
  const cropData = cropCtx.getImageData(0, 0, bw, bh);

  if (mode === 'gaussian') {
    stackBlur(cropData, Math.round(strength));
  } else if (mode === 'pixelate') {
    pixelate(cropData, Math.max(PIXELATE_MIN_BLOCK, Math.round(strength / 2)));
  }

  // Composite only across the bbox. `originalData` here is the bbox region
  // of the output (which already holds the source), so we read→blend→write a
  // bw×bh rectangle instead of width×height.
  const originalData = outCtx.getImageData(bx, by, bw, bh);
  const maskBboxData = maskCtx.getImageData(bx, by, bw, bh);
  const out = originalData.data;
  const blur = cropData.data;
  const mask = maskBboxData.data;

  for (let i = 0; i < out.length; i += 4) {
    const maskAlpha = mask[i + 3];
    if (maskAlpha > 0) {
      // Blend based on mask alpha for soft edges.
      const t = maskAlpha / 255;
      out[i] = Math.round(out[i] * (1 - t) + blur[i] * t);
      out[i + 1] = Math.round(out[i + 1] * (1 - t) + blur[i + 1] * t);
      out[i + 2] = Math.round(out[i + 2] * (1 - t) + blur[i + 2] * t);
    }
  }

  outCtx.putImageData(originalData, bx, by);
}

/**
 * Scan mask ImageData for the bounding box of all pixels with alpha > 0.
 * Returns { x, y, w, h } in pixel coordinates, or null if the mask is empty.
 *
 * Single linear scan over the alpha channel — O(width × height) with no
 * allocations. At 1 MP this is under 10 ms in modern JITs, a lot cheaper
 * than stackBlur's O(width × height × radius).
 */
function computeMaskBBox(imageData, width, height) {
  const d = imageData.data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (d[rowStart + x * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
