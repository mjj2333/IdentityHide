// Bridges Capacitor's native camera/share/filesystem plugins into the app
// without polluting the web bundle. Every plugin import is dynamic and gated
// behind isNativeApp(), so the PWA never loads any of these packages.
//
// All exported functions throw if called from a web context — callers should
// branch on `isNativeApp()` first and only invoke these on native.
import { isNativeApp, getNativePlatform } from './platform';

function assertNative() {
  if (!isNativeApp()) {
    throw new Error('nativeMedia: called from non-native context');
  }
}

/**
 * Opens the OS-native camera/library chooser and returns the picked image as
 * a `File` (so the existing handleFile pipeline works unchanged).
 *
 * @param {object} opts
 * @param {'camera'|'photos'|'prompt'} opts.source  default: 'prompt' (action sheet)
 * @returns {Promise<File|null>} null if the user cancels
 */
export async function takeNativePhoto({ source = 'prompt' } = {}) {
  assertNative();
  const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');

  const sourceMap = {
    camera: CameraSource.Camera,
    photos: CameraSource.Photos,
    prompt: CameraSource.Prompt,
  };

  try {
    const photo = await Camera.getPhoto({
      // Base64 is returned as a data string we can repackage as a File. Avoids
      // the per-platform mess of file:// URIs (different on iOS vs Android,
      // sandboxed paths, etc.) — handleFile only needs a Blob/File anyway.
      resultType: CameraResultType.Base64,
      source: sourceMap[source] ?? CameraSource.Prompt,
      quality: 95,
      // Don't let the native UI offer cropping/editing — we want the raw image
      // through to our own pipeline so resolution-tier and EXIF handling
      // behave the same as the web upload path.
      allowEditing: false,
      saveToGallery: false,
      // Pick the format hint so we know what File.type to set. iOS/Android
      // honor this for Camera capture; for Library picks the original format
      // wins regardless.
      correctOrientation: true,
    });

    if (!photo?.base64String) return null;
    const ext = (photo.format || 'jpeg').toLowerCase();
    const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const bytes = base64ToUint8Array(photo.base64String);
    return new File([bytes], `photo-${Date.now()}.${ext}`, { type: mimeType });
  } catch (err) {
    // The plugin throws on user-cancel with message "User cancelled photos
    // app". Treat that as a normal null return so callers don't surface an
    // error toast for a deliberate dismissal.
    const msg = String(err?.message || err);
    if (/cancel/i.test(msg)) return null;
    throw err;
  }
}

/**
 * Writes a Blob to the app's cache directory and opens the OS native share
 * sheet pointed at it. On iOS this surfaces "Save Image" (lands in Photos);
 * on Android it surfaces the share targets including "Save to gallery"-style
 * apps. The user picks where the file goes.
 *
 * Why share-sheet instead of direct save: avoids extra Photos write
 * permission prompts and gives the user control over the destination — same
 * mental model as Web Share, just with a real native UI.
 *
 * @param {Blob} blob
 * @param {string} filename
 * @param {string} mimeType
 * @returns {Promise<{ shared: boolean }>}  shared:false if user cancelled
 */
export async function shareNativeFile(blob, filename, mimeType) {
  assertNative();
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);

  const base64 = await blobToBase64(blob);

  // Cache dir is the right home for share-once temp files: it's writable
  // without prompting, and the OS reclaims it under storage pressure.
  const writeRes = await Filesystem.writeFile({
    path: filename,
    data: base64,
    directory: Directory.Cache,
  });

  try {
    await Share.share({
      title: filename,
      url: writeRes.uri,
      dialogTitle: 'Save or share',
    });
    return { shared: true };
  } catch (err) {
    // User-cancel manifests as a thrown rejection on iOS. Same handling as
    // Web Share — swallow and report unshared.
    const msg = String(err?.message || err);
    if (/cancel/i.test(msg)) return { shared: false };
    throw err;
  } finally {
    // Best-effort cleanup. If this fails the cache dir entry will be
    // reclaimed by the OS eventually anyway.
    try {
      await Filesystem.deleteFile({ path: filename, directory: Directory.Cache });
    } catch {}
  }
}

// Public folders the Android app saves into. Photos go under Pictures so the
// phone's gallery shows them; anything else (the batch ZIP) goes to Downloads.
const ANDROID_PHOTO_FOLDER = 'Pictures/RedactID';
const ANDROID_FILE_FOLDER = 'Download/RedactID';

function withUniqueSuffix(filename) {
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? `${filename.slice(0, dot)}_${token}${filename.slice(dot)}` : `${filename}_${token}`;
}

/**
 * Saves a file where the user will find it.
 *
 * Android: written straight into the public Pictures (or Download) folder.
 * The Android share sheet has no "save to device" target (only uploads such
 * as Google Photos or Drive), so sharing alone left people with no way to
 * keep the result on their phone. Android 11+ lets an app create its own
 * files in these folders without a permission; on older versions the write
 * is refused and we fall back to the share sheet.
 *
 * iOS: the share sheet, which offers "Save Image".
 *
 * @returns {Promise<{ outcome: 'saved', folder: string } | { outcome: 'shared' } | { outcome: 'cancelled' }>}
 */
export async function saveNativeFile(blob, filename, mimeType) {
  assertNative();
  if (getNativePlatform() === 'android') {
    try {
      const folder = await writeToAndroidPublicFolder(blob, filename, mimeType);
      return { outcome: 'saved', folder };
    } catch (err) {
      console.warn('[nativeMedia] direct save failed, using the share sheet:', err);
    }
  }
  const { shared } = await shareNativeFile(blob, filename, mimeType);
  return { outcome: shared ? 'shared' : 'cancelled' };
}

/**
 * Saves several files in one go ("Save N to Photos").
 *
 * Android: each file is written straight into the gallery folder.
 * iOS: ONE share sheet holding every file, so the user confirms once
 * ("Save 3 Images"). Opening a sheet per file used to lose photos: the plugin
 * refuses to present while the previous sheet is still on its way out.
 *
 * `getItem(i)` produces item i on demand as { blob, filename, mimeType }, or
 * null when it cannot be produced, so only one blob is held at a time.
 *
 * `count` is how many files were saved or handed to the share sheet.
 *
 * @returns {Promise<{ outcome: 'saved'|'shared'|'cancelled', count: number, failed: number, folder?: string }>}
 */
export async function saveNativeBatch(total, getItem) {
  assertNative();
  const produce = async (i) => {
    try {
      return await getItem(i);
    } catch (err) {
      console.warn('[nativeMedia] batch item failed:', err);
      return null;
    }
  };
  if (getNativePlatform() === 'android') {
    const direct = await saveBatchToAndroidPublicFolder(total, produce);
    if (direct) return direct;
  }
  return shareNativeBatch(total, produce);
}

// Returns null when the very first write is refused (older Android), so the
// caller can fall back to the share sheet for the whole batch.
async function saveBatchToAndroidPublicFolder(total, produce) {
  let count = 0;
  let failed = 0;
  let folder = ANDROID_PHOTO_FOLDER;
  for (let i = 0; i < total; i++) {
    const item = await produce(i);
    if (!item) { failed++; continue; }
    try {
      folder = await writeToAndroidPublicFolder(item.blob, item.filename, item.mimeType);
      count++;
    } catch (err) {
      if (count === 0 && failed === 0) {
        console.warn('[nativeMedia] direct save failed, using the share sheet:', err);
        return null;
      }
      console.warn('[nativeMedia] could not save', item.filename, err);
      failed++;
    }
  }
  return { outcome: 'saved', folder, count, failed };
}

async function shareNativeBatch(total, produce) {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);

  const written = [];
  const uris = [];
  let failed = 0;
  try {
    for (let i = 0; i < total; i++) {
      const item = await produce(i);
      if (!item) { failed++; continue; }
      // Photo-library picks can all carry the same name; keep them apart.
      const name = written.includes(item.filename) ? withUniqueSuffix(item.filename) : item.filename;
      const { uri } = await Filesystem.writeFile({
        path: name,
        data: await blobToBase64(item.blob),
        directory: Directory.Cache,
      });
      written.push(name);
      uris.push(uri);
    }
    if (uris.length === 0) return { outcome: 'shared', count: 0, failed };

    try {
      await Share.share({ files: uris, dialogTitle: 'Save or share' });
    } catch (err) {
      if (/cancel/i.test(String(err?.message || err))) return { outcome: 'cancelled', count: 0, failed: 0 };
      throw err;
    }
    return { outcome: 'shared', count: uris.length, failed };
  } finally {
    for (const name of written) {
      try {
        await Filesystem.deleteFile({ path: name, directory: Directory.Cache });
      } catch {
        // Best-effort; the OS reclaims the cache directory anyway.
      }
    }
  }
}

async function writeToAndroidPublicFolder(blob, filename, mimeType) {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const folder = /^image\//.test(mimeType || '') ? ANDROID_PHOTO_FOLDER : ANDROID_FILE_FOLDER;
  const data = await blobToBase64(blob);
  const write = (name) => Filesystem.writeFile({
    path: `${folder}/${name}`,
    data,
    directory: Directory.ExternalStorage,
    recursive: true,
  });

  // writeFile replaces an existing file, so never reuse a taken name.
  let name = filename;
  try {
    await Filesystem.stat({ path: `${folder}/${name}`, directory: Directory.ExternalStorage });
    name = withUniqueSuffix(filename);
  } catch {
    // Not there yet: the name is free.
  }

  try {
    await write(name);
  } catch {
    // A file of that name left by an earlier install is invisible to stat but
    // still blocks the write. One retry under a fresh name covers it.
    await write(withUniqueSuffix(filename));
  }
  return folder;
}

function base64ToUint8Array(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = binary.charCodeAt(i);
  return arr;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // FileReader gives us "data:<mime>;base64,<b64>" — strip the prefix.
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('blob read failed'));
    reader.readAsDataURL(blob);
  });
}
