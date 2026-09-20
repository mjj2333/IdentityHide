/**
 * Feature flags for trying a change on a real device before it becomes the
 * default, and for switching a new default back off if it misbehaves.
 * `?<name>=1` / `?<name>=0` set a flag and the choice persists in localStorage
 * (the router strips the query string on first render, and an installed PWA
 * can't be given one at all after that).
 *
 *   Opt-in (off unless `?name=1`):      maskgrow
 *   Default on (on unless `?name=0`):   cleanfill, colorfit
 *
 * Only a departure from the default is stored: an opt-in flag stores '1' and
 * `=0` forgets it; a default-on flag stores '0' and `=1` forgets it.
 */

export const COLORFIT_FLAG_KEY = 'ih_flag_colorfit';
export const CLEANFILL_FLAG_KEY = 'ih_flag_cleanfill';
export const MASKGROW_FLAG_KEY = 'ih_flag_maskgrow';

let colourFit = true;
let cleanFill = true;
let maskGrow = false;

export function resolveFlag(param, storageKey, search, storage, defaultOn = false) {
  const value = new URLSearchParams(search || '').get(param);
  try {
    if (defaultOn) {
      if (value === '0') storage.setItem(storageKey, '0');
      if (value === '1') storage.removeItem(storageKey);
      return storage.getItem(storageKey) !== '0';
    }
    if (value === '1') storage.setItem(storageKey, '1');
    if (value === '0') storage.removeItem(storageKey);
    return storage.getItem(storageKey) === '1';
  } catch {
    // No storage (private mode, blocked): an experiment stays off; a default
    // stays on, except that an explicit =0 still counts for this page load.
    return defaultOn ? value !== '0' : false;
  }
}

/** Call once at startup, before the router rewrites the URL. */
export function initFeatureFlags(search = globalThis.location?.search) {
  let storage = null;
  try { storage = globalThis.localStorage; } catch { /* unavailable */ }
  colourFit = resolveFlag('colorfit', COLORFIT_FLAG_KEY, search, storage, true);
  cleanFill = resolveFlag('cleanfill', CLEANFILL_FLAG_KEY, search, storage, true);
  maskGrow = !!storage && resolveFlag('maskgrow', MASKGROW_FLAG_KEY, search, storage);
}

/**
 * DEFAULT ON (?colorfit=0 switches it off for that browser).
 * Undo the inpaint round trip's colour loss by fitting a colour transform on
 * the untouched pixels (see colorFit.js). Changes nothing else about the
 * result, so removal behaves exactly as it always has. (Compositing the fill
 * onto the original fixed colour perfectly but left Touch-Up remnants crisp
 * and made removal less reliable; it was tried behind a flag and removed.)
 */
export function isColourFitEnabled() {
  return colourFit;
}

/**
 * DEFAULT ON (?cleanfill=0 goes back to the long-standing prompt).
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
