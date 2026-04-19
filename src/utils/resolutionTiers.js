/**
 * Resolution tier definitions for the "choose working resolution" modal.
 * The tier controls the megapixel count the pipeline downscales to before
 * running face detection and tattoo inpainting. Higher tiers = more detail
 * but longer processing time.
 */

// Two tiers only: Quick (1 MP, fast + small) and Original (full resolution).
// mp: Infinity on Original means "no downscale cap" — downscaleToMegapixels
// and estimateDimensions both handle Infinity naturally (Math.min collapses
// to srcMP; the `currentMP <= targetMP` branch fires with ALIGN-16 rounding).
export const TIERS = [
  { key: 'fast',   label: 'Quick',    mp: 1,        desc: 'Good for texting & social posts',              time: '~1 min' },
  { key: 'native', label: 'Original', mp: Infinity, desc: 'Full resolution — best for print & archive', time: '~3–5 min' },
];

export const DEFAULT_TIER_KEY = 'fast';
export const MAX_TIER_MP = Infinity;

const STORAGE_KEY = 'ih_tier';

/**
 * Annotate each tier with `available` (source is large enough) and
 * `effectiveMP` (min of tier target and source MP, so "Native" on a small
 * image shows the actual dimensions it'll end up with instead of the cap).
 */
export function getAvailableTiers(srcWidth, srcHeight) {
  const srcMP = (srcWidth * srcHeight) / 1_000_000;
  return TIERS.map((t) => ({
    ...t,
    // Original (mp === Infinity) is always available — it's just "don't
    // downscale", so it works even for tiny source images. For fixed-MP
    // tiers the 0.1 MP tolerance absorbs floating-point weirdness around
    // common sizes like 1920×1080 (~2.07 MP).
    available: t.mp === Infinity || t.mp <= srcMP + 0.1,
    effectiveMP: Math.min(t.mp, srcMP),
  }));
}

export function getSavedTierKey() {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) || DEFAULT_TIER_KEY;
  } catch {
    return DEFAULT_TIER_KEY;
  }
}

export function saveTierKey(key) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, key);
  } catch { /* persistence unavailable — in-memory only */ }
}

export function getTierMP(key) {
  return TIERS.find((t) => t.key === key)?.mp ?? 1;
}

/**
 * Estimate the working-canvas dimensions for a tier given a source size.
 * Matches the aspect ratio of the source. Used by the modal to preview
 * "you'll end up with ~2048×1536" style strings. Not used by the pipeline
 * itself — `downscaleToMegapixels` does the real math with ALIGN=16 rounding.
 */
export function estimateDimensions(srcWidth, srcHeight, tierMP) {
  const srcMP = (srcWidth * srcHeight) / 1_000_000;
  const effectiveMP = Math.min(tierMP, srcMP);
  if (effectiveMP >= srcMP) {
    return { width: srcWidth, height: srcHeight };
  }
  const scale = Math.sqrt(effectiveMP / srcMP);
  return {
    width: Math.round(srcWidth * scale),
    height: Math.round(srcHeight * scale),
  };
}
