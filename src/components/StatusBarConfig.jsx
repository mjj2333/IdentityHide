import { useEffect } from 'react';
import { isNativeApp } from '../utils/platform';

// Configures the native status bar to match the app's dark theme. Without
// this, Android's default style is dark text on a system-default background,
// which renders almost-invisible against the app's #0d0c0a background.
//
// Style.Light is named confusingly: it means LIGHT CONTENT (light text and
// icons), which is what you want on a DARK background. Style.Dark is the
// inverse (dark text on light bg).
//
// setBackgroundColor is Android-only; iOS ignores it but the call is safe
// (the plugin no-ops). Hex must be uppercase per the plugin's parser.
export default function StatusBarConfig() {
  useEffect(() => {
    if (!isNativeApp()) return;
    let cancelled = false;

    import('@capacitor/status-bar').then(({ StatusBar, Style }) => {
      if (cancelled) return;
      // Both calls are fire-and-forget; the plugin queues internally and
      // applies as soon as the native view hierarchy is ready.
      StatusBar.setStyle({ style: Style.Light }).catch((err) => {
        console.warn('[StatusBarConfig] setStyle failed:', err);
      });
      StatusBar.setBackgroundColor({ color: '#0D0C0A' }).catch((err) => {
        console.warn('[StatusBarConfig] setBackgroundColor failed:', err);
      });
    }).catch((err) => {
      console.warn('[StatusBarConfig] failed to load plugin:', err);
    });

    return () => { cancelled = true; };
  }, []);

  return null;
}
