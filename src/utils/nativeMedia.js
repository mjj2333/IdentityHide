// Bridges Capacitor's native camera/share/filesystem plugins into the app
// without polluting the web bundle. Every plugin import is dynamic and gated
// behind isNativeApp(), so the PWA never loads any of these packages.
//
// All exported functions throw if called from a web context — callers should
// branch on `isNativeApp()` first and only invoke these on native.
import { isNativeApp } from './platform';

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
