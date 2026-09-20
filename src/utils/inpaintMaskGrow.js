/**
 * Grow the painted tattoo mask before it is sent to the model (?maskgrow=1).
 *
 * People paint roughly: leaf tips, petal edges and thin lines stay visible
 * just outside the strokes, and that leftover ink is a strong cue — the model
 * CONTINUES the tattoo instead of removing it (measured on a real photo: the
 * floral tattoo was redrawn in 3/3 runs with the mask as painted, 0/3 once it
 * was grown). Growing the mask covers what the brush missed.
 *
 * The full grow is 32 px at the ~1 MP inpaint resolution the experiments used
 * (+24 left small artefacts, +48 was cleanest but regenerates more skin and can
 * reach clothing or background), scaled with linear size so it covers the same
 * physical distance at the 2 MP cap.
 *
 * Each painted blob is grown in proportion to how broadly it was painted, up to
 * that full distance. A flat +32 is fine on an arm but not on a hand: around
 * small finger letters it swallowed whole fingers and a ring, which came back
 * redrawn (a warped ring, once a spare fingertip). Sized per blob, the broad
 * back-of-hand piece still got +32 — smaller grows let the model redraw it from
 * the wrist ink next to it — while the letters got +17…20, and the ring and
 * fingers stayed the person's own.
 *
 * KNOWN LIMIT — why this is its own flag and not on by default: breadth is only
 * a proxy. Painted through the real editor with the default brush, the same
 * hand came out as broad merged blobs, everything got +32 (2.3× the painted
 * area), and the ring was deleted and the fingers redrawn badly, while the mask
 * as painted gave a good result. Growing helps on open skin and hurts next to
 * fingers, jewellery and clothing; geometry alone cannot tell which it is.
 */
const GROW_PX_AT_1MP = 32;
const MIN_GROW_PX = 4;
// A blob is grown by this multiple of its inner radius (its broadest point,
// centre to edge), capped at the full grow. Two ordinary overlapping brush
// strokes are broad enough to reach the cap.
const GROW_PER_INNER_RADIUS = 1.4;
// Same cut-off uploadMask() uses, so "painted" means what it means to the model.
const MASK_ALPHA_THRESHOLD = 128;
const ORTHO = 3, DIAG = 4;                    // chamfer weights, as in softMask.js; px = value / 3

/** The most any blob is grown, for a mask of this size. */
export function maskGrowPx(width, height) {
  const pixels = width * height;
  if (!(pixels > 0)) return 0;
  return Math.max(MIN_GROW_PX, Math.round(GROW_PX_AT_1MP * Math.sqrt(pixels / 1_000_000)));
}

/** How far ONE painted blob is grown, given its inner radius. */
export function blobGrowPx(innerRadiusPx, maxGrowPx) {
  const floor = Math.min(maxGrowPx, Math.max(MIN_GROW_PX, Math.round(maxGrowPx / 4)));
  return Math.max(floor, Math.min(maxGrowPx, Math.round(innerRadiusPx * GROW_PER_INNER_RADIUS)));
}

/**
 * Two-pass 3-4 chamfer sweep: lowers every value to the cheapest
 * "neighbour + step" it can reach. Values only ever go down, so whatever the
 * array is seeded with (0 = source, or a per-pixel head start) is respected.
 * Off-image neighbours are skipped, so the photo edge is not an obstacle.
 */
function chamferSweep(dist, width, height) {
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      let d = dist[i];
      if (d === 0) continue;
      if (x > 0) d = Math.min(d, dist[i - 1] + ORTHO);
      if (y > 0) {
        d = Math.min(d, dist[i - width] + ORTHO);
        if (x > 0) d = Math.min(d, dist[i - width - 1] + DIAG);
        if (x < width - 1) d = Math.min(d, dist[i - width + 1] + DIAG);
      }
      dist[i] = d;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width;
    for (let x = width - 1; x >= 0; x--) {
      const i = row + x;
      let d = dist[i];
      if (d === 0) continue;
      if (x < width - 1) d = Math.min(d, dist[i + 1] + ORTHO);
      if (y < height - 1) {
        d = Math.min(d, dist[i + width] + ORTHO);
        if (x < width - 1) d = Math.min(d, dist[i + width + 1] + DIAG);
        if (x > 0) d = Math.min(d, dist[i + width - 1] + DIAG);
      }
      dist[i] = d;
    }
  }
}

/**
 * Hard 0/1 mask with every painted blob grown by its own distance
 * (blobGrowPx of its inner radius, at most `maxGrowPx`). Strokes that touch,
 * even diagonally, are one blob. Pure function on typed arrays.
 *
 * @param {ArrayLike<number>} binary  width*height, non-zero = painted
 * @returns {Uint8Array} width*height, 1 = send to the model as "repaint this"
 */
export function growPaintedBlobs(binary, width, height, maxGrowPx) {
  const n = width * height;
  const grown = new Uint8Array(n);
  for (let i = 0; i < n; i++) grown[i] = binary[i] ? 1 : 0;
  if (!(maxGrowPx > 0)) return grown;

  // 1. How deep inside the paint each painted pixel is (distance to the nearest unpainted one).
  const FAR = 0x3fffffff;
  const depth = new Int32Array(n);
  for (let i = 0; i < n; i++) depth[i] = grown[i] ? FAR : 0;
  chamferSweep(depth, width, height);

  // 2. Blobs (8-connected flood fill) and each one's broadest point → its grow distance.
  const blobOf = new Int32Array(n);             // 0 = unpainted / not visited yet
  const growOf = [0];                           // grow distance per blob id
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (!grown[start] || blobOf[start]) continue;
    const id = growOf.length;
    let top = 0, deepest = 0;
    blobOf[start] = id;
    stack[top++] = start;
    while (top > 0) {
      const i = stack[--top];
      if (depth[i] > deepest) deepest = depth[i];
      const x = i % width, y = (i - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const j = ny * width + nx;
          if (grown[j] && !blobOf[j]) { blobOf[j] = id; stack[top++] = j; }
        }
      }
    }
    growOf.push(blobGrowPx(deepest / ORTHO, maxGrowPx));
  }

  // 3. One sweep grows them all: a blob allowed less than the full distance
  //    starts that much "further away", so its reach ends that much sooner.
  const limit = maxGrowPx * ORTHO;
  const dist = new Int32Array(n);
  for (let i = 0; i < n; i++) dist[i] = blobOf[i] ? (maxGrowPx - growOf[blobOf[i]]) * ORTHO : FAR;
  chamferSweep(dist, width, height);
  for (let i = 0; i < n; i++) if (dist[i] <= limit) grown[i] = 1;
  return grown;
}

/**
 * Canvas wrapper: returns a NEW mask canvas (alpha = painted) with every blob
 * grown for the mask's size. The input canvas — which may be the user's live
 * mask — is never modified.
 */
export function growInpaintMask(maskCanvas) {
  const { width, height } = maskCanvas;
  const painted = maskCanvas.getContext('2d').getImageData(0, 0, width, height).data;
  const binary = new Uint8Array(width * height);
  for (let i = 0; i < binary.length; i++) binary[i] = painted[i * 4 + 3] > MASK_ALPHA_THRESHOLD ? 1 : 0;
  const grown = growPaintedBlobs(binary, width, height, maskGrowPx(width, height));

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  const data = ctx.createImageData(width, height);
  for (let i = 0; i < grown.length; i++) {
    if (!grown[i]) continue;
    const p = i * 4;
    data.data[p] = 255; data.data[p + 1] = 255; data.data[p + 2] = 255; data.data[p + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return out;
}
