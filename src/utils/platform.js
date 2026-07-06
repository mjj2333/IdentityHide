// Capacitor injects `window.Capacitor` into the WebView at runtime when the
// app is running inside a native iOS/Android shell. On the web there's no such
// global. Reading it lets us branch behavior (skip SW registration, hide the
// "Add to Home Screen" prompt, route share through native plugins) without
// pulling @capacitor/core into the web bundle.
export function isNativeApp() {
  return !!(typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.());
}

export function getNativePlatform() {
  if (typeof window === 'undefined') return null;
  const p = window.Capacitor?.getPlatform?.();
  return p === 'ios' || p === 'android' ? p : null;
}

/**
 * Longest-side pixel cap for the working/editing image.
 *
 * iOS Safari enforces a hard per-tab memory ceiling and caps 2D/WebGL canvases
 * around 4096px. A 12–24MP photo creates several full-res canvases at once
 * (clean, working, output, mask, preview) plus a TF.js tensor for detection —
 * which blows past the ceiling and the tab is killed ("A problem repeatedly
 * occurred"). Capping the working image keeps the whole session in budget.
 *
 * Desktop has the headroom for much larger canvases, so its cap is just a
 * safety net for absurd inputs; normal phone/camera photos pass through
 * unchanged there, preserving full-resolution output.
 */
export function getMaxWorkingDimension() {
  if (typeof navigator === 'undefined') return 8192;
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isMobile = isIOS || /Android/.test(ua) || /Mobi/i.test(ua);
  const lowMemory = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4;
  return (isMobile || lowMemory) ? 4096 : 8192;
}
