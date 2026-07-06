import { useEffect } from 'react';
import { isNativeApp } from '../utils/platform';

// Bridges the Android hardware back button (gesture or on-screen) into the
// SPA's existing browser-back navigation. Capacitor surfaces it as the
// `backButton` event on the App plugin; without a listener, Android's
// default behavior is to exit the app, which is wrong from any screen
// other than the home/drop screen.
//
// `canGoBack` is set by Capacitor based on the WebView's history stack —
// true when the SPA has history entries (we pushed one each time
// PipelineContext.setScreen was called). Calling `window.history.back()`
// triggers the existing popstate handler in App.jsx, which already knows
// how to swap screens, guard the dirty-batch-edit case, etc. From the root
// (canGoBack === false), `App.exitApp()` cleanly closes the app — same as
// pressing back on the home screen of any native Android app.
export default function BackButtonHandler() {
  useEffect(() => {
    if (!isNativeApp()) return;

    let removeListener = null;
    let cancelled = false;

    import('@capacitor/app').then(({ App: CapApp }) => {
      if (cancelled) return;
      const handle = CapApp.addListener('backButton', ({ canGoBack }) => {
        if (canGoBack) {
          window.history.back();
        } else {
          CapApp.exitApp();
        }
      });
      Promise.resolve(handle).then((h) => {
        if (cancelled) h?.remove?.();
        else removeListener = () => h?.remove?.();
      });
    }).catch((err) => {
      console.warn('[BackButtonHandler] failed to load @capacitor/app:', err);
    });

    return () => {
      cancelled = true;
      if (removeListener) removeListener();
    };
  }, []);

  return null;
}
