/**
 * IndexedDB session persistence — saves work-in-progress so it survives page closes.
 * Stores: original file, tattoo mask, key canvases, screen position, settings.
 */

const DB_NAME = 'identityhide';
const DB_VERSION = 1;
const STORE = 'session';
const SESSION_KEY = 'current';

// How long a saved session is allowed to persist before it's auto-discarded
// on next load. This is a privacy trade-off: long enough to survive a browser
// crash / accidental tab close and let the user resume the same work session,
// short enough that sensitive uploads don't linger overnight on a shared or
// lost device. 4h covers typical "got interrupted, back after lunch" flows.
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => {
    if (!canvas || !canvas.width || !canvas.height) { resolve(null); return; }
    canvas.toBlob((blob) => resolve(blob), 'image/png');
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
 * Save current session to IndexedDB. Throws on failure so callers can surface
 * the problem — typically a QuotaExceededError when the image exceeds the
 * browser's storage budget. Callers should debounce warnings to avoid spamming
 * the user on every auto-save tick.
 */
export async function saveSession({ originalFile, screen, blurSettings, feather, detections,
  editDets, tierMP, tattooMaskCanvas, strippedCanvas, inpaintedCanvas, outputCanvas,
  originalCanvas, fullResCanvas }) {
  const [tattooBlob, strippedBlob, inpaintedBlob, outputBlob, originalBlob, fullResBlob] =
    await Promise.all([
      canvasToBlob(tattooMaskCanvas),
      canvasToBlob(strippedCanvas),
      canvasToBlob(inpaintedCanvas),
      canvasToBlob(outputCanvas),
      canvasToBlob(originalCanvas),
      canvasToBlob(fullResCanvas),
    ]);

  const data = {
    originalFile,
    screen,
    blurSettings,
    feather,
    detections,
    editDets,
    tierMP,
    tattooMaskBlob: tattooBlob,
    strippedBlob,
    inpaintedBlob,
    outputBlob,
    originalBlob,
    fullResBlob,
    savedAt: Date.now(),
  };

  const db = await openDB();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(data, SESSION_KEY);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  } finally {
    db.close();
  }
}

/**
 * Load saved session from IndexedDB. Returns null if none exists. Throws on
 * genuine errors (corrupt store, blob decode failure, etc.) so the UI can
 * tell the user "we found a session but couldn't restore it" instead of
 * silently dropping their work.
 */
export async function loadSession() {
  const db = await openDB();
  let data;
  try {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(SESSION_KEY);
    data = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }

  if (!data) return null;

  // Discard sessions older than the TTL
  if (Date.now() - data.savedAt > SESSION_TTL_MS) {
    await clearSession();
    return null;
  }

  const [tattooMaskCanvas, strippedCanvas, inpaintedCanvas, outputCanvas, originalCanvas, fullResCanvas] =
    await Promise.all([
      blobToCanvas(data.tattooMaskBlob),
      blobToCanvas(data.strippedBlob),
      blobToCanvas(data.inpaintedBlob),
      blobToCanvas(data.outputBlob),
      blobToCanvas(data.originalBlob),
      blobToCanvas(data.fullResBlob),
    ]);

  return {
    originalFile: data.originalFile,
    screen: data.screen,
    blurSettings: data.blurSettings,
    feather: data.feather,
    detections: data.detections || [],
    editDets: data.editDets || [],
    tierMP: data.tierMP || 1,
    tattooMaskCanvas,
    strippedCanvas,
    inpaintedCanvas,
    outputCanvas,
    originalCanvas,
    fullResCanvas,
  };
}

/**
 * Lightweight peek at the saved session — returns metadata the restore banner
 * needs to identify what it's about to restore (filename, screen, timestamp)
 * without paying the cost of decoding the blobs. Returns null if no session
 * exists or if the saved session has expired.
 */
export async function getSessionInfo() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(SESSION_KEY);
    const data = await new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = reject; });
    db.close();
    if (!data) return null;
    if (Date.now() - data.savedAt > SESSION_TTL_MS) return null;
    return {
      filename: data.originalFile?.name || null,
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
    tx.objectStore(STORE).delete(SESSION_KEY);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
    db.close();
  } catch (e) {
    console.warn('[sessionStore] clear failed:', e.message);
  }
}
