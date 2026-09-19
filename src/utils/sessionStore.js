/**
 * IndexedDB session persistence — saves work-in-progress so it survives page closes.
 *
 * Layout (one keyless object store, several keys, so a save can rewrite just
 * the part that changed — see sessionSaver.js for the diffing):
 *   meta            screen, settings, regions, tier, filename, savedAt
 *   originalFile    the uploaded File, written once per image
 *   canvas:<slot>   one PNG blob per working canvas (tattooMask / stripped /
 *                   inpainted / output)
 *
 * The full-resolution "original" canvas is deliberately NOT stored: it is a
 * deterministic function of originalFile, so restore rebuilds it instead of
 * every save paying to PNG-encode ~12 MP (it used to be encoded twice per
 * save — as `original` and as an identical, never-read `fullRes` copy).
 *
 * Sessions written by the previous single-record layout are still readable
 * (LEGACY_KEY) so an update doesn't silently drop someone's unsaved work; the
 * record is deleted on the next save.
 */

import { diagSpan } from './perfDiagnostics';
import { fileToCanvas, capToMaxDimension } from './imageHelpers';
import { getMaxWorkingDimension } from './platform';

const DB_NAME = 'identityhide';
const DB_VERSION = 1;
const STORE = 'session';
const META_KEY = 'meta';
const FILE_KEY = 'originalFile';
const LEGACY_KEY = 'current';
const CANVAS_SLOTS = ['tattooMask', 'stripped', 'inpainted', 'output'];
const canvasKey = (slot) => `canvas:${slot}`;

// How long a saved session is allowed to persist before it's auto-discarded
// on next load. This is a privacy trade-off: long enough to survive a browser
// crash / accidental tab close and let the user resume the same work session,
// short enough that sensitive uploads don't linger overnight on a shared or
// lost device. 4h covers typical "got interrupted, back after lunch" flows.
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;

const isExpired = (savedAt) => Date.now() - savedAt > SESSION_TTL_MS;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Read several keys in one readonly transaction → { key: value }. */
async function readKeys(keys) {
  const db = await openDB();
  try {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    const values = await Promise.all(keys.map((key) => new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    })));
    return Object.fromEntries(keys.map((key, i) => [key, values[i]]));
  } finally {
    db.close();
  }
}

/**
 * PNG-encode one canvas. `slot` only labels the diagnostics entry (?diag=1).
 * Injected into the session saver as its `encode`.
 */
export function encodeCanvas(canvas, slot) {
  return new Promise((resolve) => {
    if (!canvas || !canvas.width || !canvas.height) { resolve(null); return; }
    const endEncode = diagSpan('encode', { name: slot, w: canvas.width, h: canvas.height });
    // syncMs = how long the toBlob() call itself blocked. Engines that encode
    // synchronously (WebKit) spend the whole encode here, on the main thread;
    // ones that encode off-thread return almost immediately.
    let syncMs = 0;
    const t0 = performance.now();
    canvas.toBlob((blob) => {
      endEncode({ syncMs, kb: blob ? Math.round(blob.size / 1024) : 0 });
      resolve(blob);
    }, 'image/png');
    syncMs = Math.round(performance.now() - t0);
  });
}

function blobToCanvas(blob) {
  return new Promise((resolve) => {
    if (!blob) { resolve(null); return; }
    // Use img.decode() so the URL revoke lives in a finally block — the
    // previous onload/onerror pair could leak the object URL if neither
    // fired (e.g., tab teardown races the image decode). With decode(),
    // every completion path (success, failure, or settle-during-teardown)
    // runs the revoke exactly once.
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    img.decode()
      .then(() => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        resolve(c);
      })
      .catch(() => resolve(null))
      .finally(() => URL.revokeObjectURL(url));
  });
}

/**
 * Apply one batch of session changes atomically (single transaction).
 * Injected into the session saver as its `write`. Throws on failure so
 * callers can surface the problem — typically a QuotaExceededError when the
 * image exceeds the browser's storage budget. Callers should debounce
 * warnings to avoid spamming the user on every auto-save tick.
 */
export async function writeSession({ put = {}, remove = [] }) {
  const endPut = diagSpan('idb-put', { keys: Object.keys(put).join(',') });
  const db = await openDB();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const [key, value] of Object.entries(put)) store.put(value, key);
    for (const key of remove) store.delete(key);
    store.delete(LEGACY_KEY);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    endPut();
  } finally {
    db.close();
  }
}

/** Same capped, metadata-stripped original that runPipeline builds on import. */
async function rebuildOriginalCanvas(file) {
  if (!file) return null;
  try {
    const clean = await fileToCanvas(file);
    const capped = capToMaxDimension(clean, getMaxWorkingDimension());
    if (capped.scaled) { clean.width = 0; clean.height = 0; }
    return capped.canvas;
  } catch {
    // Before/after compare is a nicety — never fail a restore over it.
    return null;
  }
}

function sessionShape(data, canvases) {
  return {
    originalFile: data.originalFile,
    screen: data.screen,
    blurSettings: data.blurSettings,
    feather: data.feather,
    detections: data.detections || [],
    // Migrate pre-"kind" sessions: every region defaults to a blur object.
    editDets: (data.editDets || []).map(d => ({ ...d, kind: d.kind || 'blur' })),
    tierMP: data.tierMP || 1,
    ...canvases,
  };
}

/**
 * Load saved session from IndexedDB. Returns null if none exists. Throws on
 * genuine errors (corrupt store, blob decode failure, etc.) so the UI can
 * tell the user "we found a session but couldn't restore it" instead of
 * silently dropping their work.
 *
 * `legacy: true` marks a session read from the old single-record layout —
 * nothing from it exists under the new keys yet, so the caller must NOT tell
 * the saver it is already on disk.
 */
export async function loadSession() {
  const keys = [META_KEY, FILE_KEY, LEGACY_KEY, ...CANVAS_SLOTS.map(canvasKey)];
  const stored = await readKeys(keys);
  const meta = stored[META_KEY];
  const legacy = stored[LEGACY_KEY];

  if (!meta && !legacy) return null;

  // Discard sessions older than the TTL
  if (isExpired((meta || legacy).savedAt)) {
    await clearSession();
    return null;
  }

  const endDecode = diagSpan('restore-decode', { legacy: !meta });
  if (!meta) {
    const [tattooMaskCanvas, strippedCanvas, inpaintedCanvas, outputCanvas, originalCanvas] =
      await Promise.all([
        blobToCanvas(legacy.tattooMaskBlob),
        blobToCanvas(legacy.strippedBlob),
        blobToCanvas(legacy.inpaintedBlob),
        blobToCanvas(legacy.outputBlob),
        blobToCanvas(legacy.originalBlob),
      ]);
    endDecode();
    return {
      ...sessionShape(legacy, { tattooMaskCanvas, strippedCanvas, inpaintedCanvas, outputCanvas, originalCanvas }),
      legacy: true,
    };
  }

  const originalFile = stored[FILE_KEY] || null;
  const [tattooMaskCanvas, strippedCanvas, inpaintedCanvas, outputCanvas, originalCanvas] =
    await Promise.all([
      ...CANVAS_SLOTS.map((slot) => blobToCanvas(stored[canvasKey(slot)])),
      rebuildOriginalCanvas(originalFile),
    ]);
  endDecode();
  return sessionShape(
    { ...meta, originalFile },
    { tattooMaskCanvas, strippedCanvas, inpaintedCanvas, outputCanvas, originalCanvas },
  );
}

/**
 * Lightweight peek at the saved session — returns metadata the restore banner
 * needs to identify what it's about to restore (filename, screen, timestamp)
 * without paying the cost of decoding the blobs. Returns null if no session
 * exists or if the saved session has expired.
 */
export async function getSessionInfo() {
  try {
    const stored = await readKeys([META_KEY, LEGACY_KEY]);
    const meta = stored[META_KEY];
    const legacy = stored[LEGACY_KEY];
    const data = meta || legacy;
    if (!data || isExpired(data.savedAt)) return null;
    return {
      filename: (meta ? meta.filename : legacy.originalFile?.name) || null,
      screen: data.screen || null,
      savedAt: data.savedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Clear saved session.
 */
export async function clearSession() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
    db.close();
  } catch (e) {
    console.warn('[sessionStore] clear failed:', e.message);
  }
}
