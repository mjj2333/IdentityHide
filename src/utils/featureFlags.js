/**
 * Opt-in feature flags for trying a change on a real device before it becomes
 * the default. `?<name>=1` turns a flag on and persists it in localStorage (the
 * router strips the query string on first render, and an installed PWA can't
 * be given one at all after that); `?<name>=0` turns it off and forgets it.
 * Everything is OFF unless someone has explicitly opted in on that browser.
 */

export const COMPOSITE_FLAG_KEY = 'ih_flag_composite';
export const GRAIN_FLAG_KEY = 'ih_flag_grain';
export const COLORFIT_FLAG_KEY = 'ih_flag_colorfit';
export const CLEANFILL_FLAG_KEY = 'ih_flag_cleanfill';
export const MASKGROW_FLAG_KEY = 'ih_flag_maskgrow';

let inpaintComposite = false;
let grainMatch = false;
let colourFit = false;
let cleanFill = false;
let maskGrow = false;

export function resolveFlag(param, storageKey, search, storage) {
  try {
    const value = new URLSearchParams(search || '').get(param);
    if (value === '1') storage.setItem(storageKey, '1');
    if (value === '0') storage.removeItem(storageKey);
    return storage.getItem(storageKey) === '1';
  } catch {
    return false;
  }
}

/** Call once at startup, before the router rewrites the URL. */
export function initFeatureFlags(search = globalThis.location?.search) {
  let storage = null;
  try { storage = globalThis.localStorage; } catch { /* unavailable */ }
  inpaintComposite = !!storage && resolveFlag('composite', COMPOSITE_FLAG_KEY, search, storage);
  grainMatch = !!storage && resolveFlag('grain', GRAIN_FLAG_KEY, search, storage);
  colourFit = !!storage && resolveFlag('colorfit', COLORFIT_FLAG_KEY, search, storage);
  cleanFill = !!storage && resolveFlag('cleanfill', CLEANFILL_FLAG_KEY, search, storage);
  maskGrow = !!storage && resolveFlag('maskgrow', MASKGROW_FLAG_KEY, search, storage);
}

/**
 * Tattoo removal keeps the ORIGINAL pixels outside a grown, feathered copy of
 * the painted mask instead of adopting the model's whole re-decoded frame
 * (see inpaintComposite.js). Off = the long-standing behaviour.
 */
export function isInpaintCompositeEnabled() {
  return inpaintComposite;
}

/**
 * Add matching photo grain to the composited patch (see grainMatch.js). Only
 * meaningful on top of compositing — without it there is no separate patch to
 * match — so ?grain=1 alone does nothing.
 */
export function isGrainMatchEnabled() {
  return inpaintComposite && grainMatch;
}

/**
 * Undo the inpaint round trip's colour loss by fitting a colour transform on
 * the untouched pixels (see colorFit.js). Changes nothing else about the
 * result — no compositing — so removal behaves exactly as it always has.
 * Independent of the composite flag; with both on, the fill is colour-fitted
 * before it is composited.
 */
export function isColourFitEnabled() {
  return colourFit;
}

/**
 * Send a skin-only positive prompt (see comfyuiWorkflows.CLEAN_SKIN_PROMPT).
 * This flag and the next are the only ones that change what the MODEL is asked
 * to do; the others only change what is done with its answer.
 */
export function isCleanFillEnabled() {
  return cleanFill;
}

/**
 * Grow the painted mask before upload (see inpaintMaskGrow.js). Kept separate
 * from the prompt because it is a trade-off, not a plain win: it stops the
 * model continuing leftover ink on open skin (arm: redrawn 3/3 -> 0/3), but on a
 * hand painted with the default brush it swallowed the fingers and a ring,
 * which came back redrawn - worse than not growing at all.
 */
export function isMaskGrowEnabled() {
  return maskGrow;
}
