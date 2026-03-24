/**
 * IndexedDB store for image+mask training pairs.
 * Used to collect data for on-device tattoo segmentation training.
 * Supports per-subject training data (v2 schema).
 */
import { canvasToBlob } from './imageHelpers';

const DB_NAME = 'identityhide-training';
const DB_VERSION = 2;
const STORE_NAME = 'pairs';

let dbInstance = null;

function getDB() {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const tx = e.target.transaction;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // Fresh install
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('timestamp', 'timestamp');
        store.createIndex('subject', 'subject');
      } else if (e.oldVersion < 2) {
        // Migrate v1 -> v2: add subject index, backfill existing records
        const store = tx.objectStore(STORE_NAME);
        if (!store.indexNames.contains('subject')) {
          store.createIndex('subject', 'subject');
        }
        // Backfill existing records with subject = 'default'
        const cursor = store.openCursor();
        cursor.onsuccess = (ev) => {
          const c = ev.target.result;
          if (c) {
            if (!c.value.subject) {
              c.update({ ...c.value, subject: 'default' });
            }
            c.continue();
          }
        };
      }
    };

    req.onsuccess = (e) => {
      dbInstance = e.target.result;
      resolve(dbInstance);
    };

    req.onerror = () => reject(req.error);
  });
}

/**
 * Save an image+mask pair. Returns the auto-generated id.
 */
export async function saveTrainingPair(imageCanvas, maskCanvas, subject = 'default') {
  const [imageBlob, maskBlob] = await Promise.all([
    canvasToBlob(imageCanvas, 'image/png'),
    canvasToBlob(maskCanvas, 'image/png'),
  ]);

  // Count masked pixels
  const maskCtx = maskCanvas.getContext('2d');
  const maskData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
  let maskPixelCount = 0;
  for (let i = 3; i < maskData.length; i += 4) {
    if (maskData[i] > 128) maskPixelCount++;
  }

  const record = {
    imageBlob,
    maskBlob,
    width: imageCanvas.width,
    height: imageCanvas.height,
    maskPixelCount,
    subject,
    timestamp: Date.now(),
  };

  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * List pairs (metadata only, no blobs). Sorted newest first.
 * If subject is provided, only returns pairs for that subject.
 */
export async function listTrainingPairs(subject = null) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const results = [];

    let req;
    if (subject) {
      const idx = store.index('subject');
      req = idx.openCursor(IDBKeyRange.only(subject));
    } else {
      const idx = store.index('timestamp');
      req = idx.openCursor(null, 'prev');
    }

    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const { id, width, height, maskPixelCount, subject: s, timestamp } = cursor.value;
        results.push({ id, width, height, maskPixelCount, subject: s, timestamp });
        cursor.continue();
      } else {
        // Sort newest first when filtered by subject (index is on subject, not timestamp)
        if (subject) results.sort((a, b) => b.timestamp - a.timestamp);
        resolve(results);
      }
    };

    req.onerror = () => reject(req.error);
  });
}

/**
 * Get a single pair by id (full record including blobs).
 */
export async function getTrainingPair(id) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Delete a pair by id.
 */
export async function deleteTrainingPair(id) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get count of stored pairs, optionally filtered by subject.
 */
export async function getTrainingPairCount(subject = null) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    let req;
    if (subject) {
      req = store.index('subject').count(IDBKeyRange.only(subject));
    } else {
      req = store.count();
    }
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * List distinct subject names across all stored pairs.
 */
export async function listSubjects() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const idx = tx.objectStore(STORE_NAME).index('subject');
    const req = idx.openKeyCursor(null, 'nextunique');
    const subjects = [];

    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        subjects.push(cursor.key);
        cursor.continue();
      } else {
        resolve(subjects);
      }
    };

    req.onerror = () => reject(req.error);
  });
}

/**
 * Delete all training pairs, optionally filtered by subject.
 * If no subject given, clears everything.
 */
export async function clearAllTrainingPairs(subject = null) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    if (!subject) {
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    } else {
      const idx = store.index('subject');
      const req = idx.openCursor(IDBKeyRange.only(subject));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => reject(req.error);
    }
  });
}
