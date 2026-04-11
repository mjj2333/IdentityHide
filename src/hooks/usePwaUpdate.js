import { useEffect, useRef, useState, useCallback } from 'react';
import { track } from '../utils/analytics';

// How often to poll for a new service worker while the tab is open. 60 min is
// a good balance: cheap (a single HEAD-equivalent on /sw.js) and fast enough
// that users on long-lived PWA sessions don't sit on stale code for hours.
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * PWA update detection.
 *
 * Registers the service worker, watches for a new worker reaching the
 * `installed` state while another worker is already in control, and exposes
 * a flag the UI can use to prompt the user. When the user accepts, we
 * postMessage the waiting worker to skip waiting and reload once the new
 * worker takes control.
 *
 * Call this exactly once at the top of the component tree. Calling it in
 * multiple places would register the SW multiple times and could create
 * conflicting reload flags.
 */
export function usePwaUpdate() {
  const [updateReady, setUpdateReady] = useState(false);
  // The waiting worker we'll tell to skip-waiting when the user clicks Reload.
  // Stored in a ref because we don't need to re-render when it changes.
  const waitingWorkerRef = useRef(null);
  // Once the user clicks Reload and we've posted SKIP_WAITING, the new worker
  // takes control and fires `controllerchange`. We only want to reload the
  // page once, so this flag guards against Chrome firing the event multiple
  // times in edge cases (e.g. hard refresh during the handshake).
  const refreshingRef = useRef(false);
  // Track whether we've already reported this particular update to analytics.
  // `updatefound` can fire again if yet another SW is built and deployed while
  // the toast is already up, and we don't want to double-count.
  const trackedRef = useRef(false);

  const markUpdateReady = useCallback((worker) => {
    if (!worker) return;
    waitingWorkerRef.current = worker;
    setUpdateReady(true);
    if (!trackedRef.current) {
      trackedRef.current = true;
      track('pwa_update_available');
    }
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    let registration = null;
    let intervalId = null;
    let cancelled = false;

    const onControllerChange = () => {
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    // Watch the installing worker and flip our flag the moment it's installed
    // AND there's already a controller (= this is an update, not first install).
    const watchInstalling = (installing) => {
      if (!installing) return;
      const onStateChange = () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          markUpdateReady(installing);
          installing.removeEventListener('statechange', onStateChange);
        }
      };
      installing.addEventListener('statechange', onStateChange);
    };

    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        if (cancelled) return;
        registration = reg;

        // If a worker is already waiting when we register (e.g. user dismissed
        // the toast last session and reloaded without applying the update),
        // promote it to updateReady immediately.
        if (reg.waiting && navigator.serviceWorker.controller) {
          markUpdateReady(reg.waiting);
        }

        // Watch any worker that's installing right now.
        if (reg.installing) watchInstalling(reg.installing);

        // And any that start installing in the future.
        reg.addEventListener('updatefound', () => {
          trackedRef.current = false; // allow re-tracking for a new cycle
          watchInstalling(reg.installing);
        });

        // Periodic check while the tab is open.
        intervalId = setInterval(() => {
          reg.update().catch(() => {});
        }, UPDATE_CHECK_INTERVAL_MS);
      })
      .catch(() => {
        // Match the prior index.html behaviour: swallow registration errors.
        // Failed registration just means no offline/PWA features, which is
        // already the degraded state for unsupported browsers.
      });

    // Re-check when the tab becomes visible again. Covers the case where a
    // user backgrounds the installed PWA for a few hours and comes back.
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && registration) {
        registration.update().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      if (intervalId) clearInterval(intervalId);
    };
  }, [markUpdateReady]);

  const applyUpdate = useCallback(() => {
    const worker = waitingWorkerRef.current;
    if (!worker) {
      // Defensive: if we somehow lost the handle, just reload. Worst case the
      // browser will pick up the new SW on next navigation anyway.
      track('pwa_update_applied');
      window.location.reload();
      return;
    }
    track('pwa_update_applied');
    worker.postMessage({ type: 'SKIP_WAITING' });
    // The actual reload happens in the `controllerchange` handler above once
    // the new worker takes control. This keeps the flow consistent whether
    // the handshake takes 50ms or 500ms.
  }, []);

  const dismiss = useCallback(() => {
    track('pwa_update_dismissed');
    setUpdateReady(false);
  }, []);

  return { updateReady, applyUpdate, dismiss };
}
