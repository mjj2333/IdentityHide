import { useEffect } from 'react';
import { useEntitlement } from '../context/EntitlementContext';
import { isNativeApp } from '../utils/platform';

// Bridges Universal Links into the in-app router. On web this is a no-op —
// the browser already handles same-origin navigation natively. On native
// (Capacitor iOS/Android), the OS hands us the inbound URL via the
// `appUrlOpen` event and we parse it ourselves.
//
// Currently the only deep link we care about is /success?session_id=… which
// happens when the user finishes Stripe Checkout in external Safari and the
// OS hands control back to the app. /account is also declared in the AASA
// for future use (e.g. an email link asking the user to manage billing).
export default function DeepLinkHandler() {
  const { consumeStripeSuccess } = useEntitlement();

  useEffect(() => {
    if (!isNativeApp()) return;

    let removeListener = null;
    let cancelled = false;

    // Dynamic import keeps @capacitor/app out of the web bundle — it only
    // loads when we're actually running inside the native shell.
    import('@capacitor/app')
      .then(({ App: CapApp }) => {
        if (cancelled) return;
        const handle = CapApp.addListener('appUrlOpen', ({ url }) => {
          try {
            const u = new URL(url);
            if (u.pathname === '/success') {
              const sessionId = u.searchParams.get('session_id');
              if (sessionId) consumeStripeSuccess(sessionId);
            }
            // /account: route into the AccountScreen. For now we just no-op
            // because that flow is web-only — wire it once the native paywall
            // ships and we want billing-management deep links.
          } catch (err) {
            console.warn('[DeepLinkHandler] bad inbound URL:', url, err);
          }
        });
        // CapApp.addListener returns a Promise<PluginListenerHandle> in v8+
        Promise.resolve(handle).then((h) => {
          if (cancelled) {
            h?.remove?.();
          } else {
            removeListener = () => h?.remove?.();
          }
        });
      })
      .catch((err) => {
        console.warn('[DeepLinkHandler] failed to load @capacitor/app:', err);
      });

    return () => {
      cancelled = true;
      if (removeListener) removeListener();
    };
  }, [consumeStripeSuccess]);

  return null;
}
