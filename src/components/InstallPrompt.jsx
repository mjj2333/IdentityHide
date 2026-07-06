import { useState, useEffect, useRef, useCallback } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';

const DISMISSED_KEY = 'install_prompt_dismissed';
const DISMISS_DAYS = 30;

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

function getPlatform() {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
    return 'ios';
  }
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

function getBrowserName() {
  const ua = navigator.userAgent;
  if (/SamsungBrowser/i.test(ua)) return 'Samsung Internet';
  if (/Firefox/i.test(ua)) return 'Firefox';
  if (/Edg/i.test(ua)) return 'Edge';
  if (/OPR|Opera/i.test(ua)) return 'Opera';
  if (/CriOS/i.test(ua)) return 'Chrome';
  if (/Chrome/i.test(ua)) return 'Chrome';
  if (/Safari/i.test(ua)) return 'Safari';
  return 'your browser';
}

function getMenuInstruction() {
  const platform = getPlatform();
  const browser = getBrowserName();

  if (platform === 'ios') {
    return <>Tap the <strong>Share</strong> button <ShareIcon /> then tap <strong>&ldquo;Add to Home Screen&rdquo;</strong>.</>;
  }

  if (browser === 'Samsung Internet') {
    return <>Tap the <strong>menu</strong> button <MenuIcon /> then tap <strong>&ldquo;Add page to&rdquo;</strong> &rarr; <strong>&ldquo;Home screen&rdquo;</strong>.</>;
  }

  if (browser === 'Firefox') {
    return <>Tap the <strong>menu</strong> button <MenuIcon /> then tap <strong>&ldquo;Install&rdquo;</strong> or <strong>&ldquo;Add to Home screen&rdquo;</strong>.</>;
  }

  if (platform === 'android') {
    return <>Tap the <strong>menu</strong> button <MenuIcon /> then tap <strong>&ldquo;Add to Home screen&rdquo;</strong> or <strong>&ldquo;Install app&rdquo;</strong>.</>;
  }

  return <>Click the install icon in the address bar, or use the browser menu &rarr; <strong>&ldquo;Install Redact.ID&rdquo;</strong>.</>;
}

function ShareIcon() {
  return (
    <svg className="install-inline-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg className="install-inline-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" />
    </svg>
  );
}

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [show, setShow] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [waitedForNative, setWaitedForNative] = useState(false);
  const promptRef = useRef(null);
  useFocusTrap(promptRef);

  // Pick up event captured globally (in index.html) + listen for future ones
  useEffect(() => {
    if (window.__pwaInstallPrompt) {
      setDeferredPrompt(window.__pwaInstallPrompt);
    }
    const handler = (e) => {
      e.preventDefault();
      window.__pwaInstallPrompt = e;
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  // Wait for SW + give browser time to fire beforeinstallprompt, then show
  useEffect(() => {
    if (isStandalone()) return;

    const dismissed = localStorage.getItem(DISMISSED_KEY);
    if (dismissed) {
      const ts = parseInt(dismissed, 10);
      if (Date.now() - ts < DISMISS_DAYS * 24 * 60 * 60 * 1000) return;
    }

    let cancelled = false;
    const waitAndShow = async () => {
      // Wait for the service worker to be active (required for installability)
      try {
        if ('serviceWorker' in navigator) {
          await Promise.race([
            navigator.serviceWorker.ready,
            new Promise(r => setTimeout(r, 5000)),
          ]);
        }
      } catch {}
      // Give the browser 2 more seconds to fire beforeinstallprompt
      await new Promise(r => setTimeout(r, 2000));
      if (!cancelled && !dismissedRef.current) {
        setWaitedForNative(true);
        setShow(true);
      }
    };

    waitAndShow();
    return () => { cancelled = true; };
  }, []);

  // If native prompt arrives early, show immediately (unless dismissed)
  useEffect(() => {
    if (deferredPrompt && !show && !dismissedRef.current) {
      setShow(true);
    }
  }, [deferredPrompt, show]);

  useEffect(() => {
    if (show) promptRef.current?.focus();
  }, [show]);

  const dismissedRef = useRef(false);
  const dismiss = useCallback(() => {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    dismissedRef.current = true;
    setShow(false);
  }, []);

  const handleInstall = useCallback(async () => {
    if (!deferredPrompt) return;
    setInstalling(true);
    deferredPrompt.prompt();
    const result = await deferredPrompt.userChoice;
    setInstalling(false);
    if (result.outcome === 'accepted') {
      setShow(false);
    }
    setDeferredPrompt(null);
    window.__pwaInstallPrompt = null;
  }, [deferredPrompt]);

  if (!show || isStandalone()) return null;

  const hasNativePrompt = !!deferredPrompt;

  return (
    <div className="install-prompt-backdrop" onClick={dismiss}>
      <div
        className="install-prompt"
        ref={promptRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Install Redact.ID"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="install-prompt-header">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v13M5 10l7 7 7-7" />
            <path d="M3 17v3a2 2 0 002 2h14a2 2 0 002-2v-3" />
          </svg>
          <h2>Install Redact.ID</h2>
        </div>

        <p className="install-prompt-body">
          Add to your home screen for quick access. Face blur and metadata stripping run locally on your device, so they keep working even if you go offline.
        </p>

        {hasNativePrompt ? (
          <div className="install-prompt-actions">
            <button
              className="btn btn-primary"
              onClick={handleInstall}
              disabled={installing}
            >
              {installing ? 'Installing...' : 'Install'}
            </button>
          </div>
        ) : waitedForNative ? (
          <div className="install-prompt-instructions">
            <p>{getMenuInstruction()}</p>
          </div>
        ) : null}

        <button className="install-prompt-dismiss" onClick={dismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}
