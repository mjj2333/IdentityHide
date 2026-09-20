/**
 * Turn a hard painted mask into a grown, feathered alpha mask.
 *
 *   alpha = 255                      within `growPx` of any painted pixel
 *   alpha = smooth ramp 255 → 0      over the next `featherPx`
 *   alpha = 0                        beyond that
 *
 * Used to mark everything the model may have repainted: it rewrites pixels
 * well beyond the painted strokes (measured ~16–24 px at the inpaint
 * resolution, from the latent grid + decoder receptive field), so anything
 * that must treat "painted" and "untouched" pixels differently — today the
 * colour fit, which learns only from untouched pixels (inpaintColorFit.js) —
 * has to grow the painted mask first. The feather is there for callers that
 * blend across the edge rather than cut.
 *
 * Distances come from a two-pass 3-4 chamfer transform: O(n), a few % off true
 * Euclidean, which is far below what a feathered edge can show. Pure function
 * on typed arrays (no canvas) so it is unit-testable.
 *
 * @param {ArrayLike<number>} binary  width*height, non-zero = painted
 * @returns {Uint8ClampedArray} width*height alpha values
 */
export function buildSoftMask(binary, width, height, growPx, featherPx) {
  const n = width * height;
  const ORTHO = 3, DIAG = 4;                 // chamfer weights; distance in px = value / 3
  const reach = (growPx + featherPx) * ORTHO;
  const FAR = reach + DIAG + 1;               // anything past the feather is "far" — no need to be exact
  const dist = new Uint16Array(n);
  for (let i = 0; i < n; i++) dist[i] = binary[i] ? 0 : FAR;

  // Forward pass: nearest painted pixel above / to the left.
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
      dist[i] = Math.min(d, FAR);
    }
  }
  // Backward pass: nearest painted pixel below / to the right.
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
      dist[i] = Math.min(d, FAR);
    }
  }

  const alpha = new Uint8ClampedArray(n);
  const grow = growPx * ORTHO;
  const feather = featherPx * ORTHO;
  for (let i = 0; i < n; i++) {
    const d = dist[i];
    if (d <= grow) alpha[i] = 255;
    else if (feather > 0 && d < grow + feather) {
      const t = (d - grow) / feather;           // 0 at the grown edge → 1 at the outer edge
      alpha[i] = 255 * (1 - t * t * (3 - 2 * t)); // smoothstep: no visible kink at either end
    }
  }
  return alpha;
}
