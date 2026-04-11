/**
 * Resolution tier definitions for the "choose working resolution" modal.
 * The tier controls the megapixel count the pipeline downscales to before
 * running face detection and tattoo inpainting. Higher tiers = more detail
 * but longer processing time.
 */

export const TIERS = [
  { key: 'fast',     label: 'Fast',     mp: 1,  desc: 'Social media, messaging',   time: '~1 min' },
  { key: 'balanced', label: 'Balanced', mp: 2,  desc: 'Sharing, small prints',     time: '~1.5 min' },
  { key: 'high',     label: 'High',     mp: 4,  desc: 'Prints, large displays',    time: '~3 min' },
  { key: 'native',   label: 'Native',   mp: 12, desc: 'Max detail, pro print',     time: '~5 min' },
];

export const DEFAULT_TIER_KEY = 'fast';
export const MAX_TIER_MP = 12;

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
    // 0.1 MP tolerance so a 1920×1080 (~2.07 MP) upload still enables the
    // 2 MP tier without floating-point weirdness getting in the way.
    available: t.mp <= srcMP + 0.1,
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
