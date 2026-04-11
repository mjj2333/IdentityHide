import { useEffect, useRef, lazy, Suspense } from 'react';
import { PipelineProvider, usePipeline } from './context/PipelineContext';
import DropZone from './components/DropZone';
import LoadingOverlay from './components/LoadingOverlay';
import ThemeToggle from './components/ThemeToggle';
import InstallPrompt from './components/InstallPrompt';
import UpdatePrompt from './components/UpdatePrompt';
import { usePwaUpdate } from './hooks/usePwaUpdate';
import { track } from './utils/analytics';
import './styles/global.css';

const MaskEditorScreen = lazy(() => import('./components/MaskEditorScreen'));
const ReviewScreen = lazy(() => import('./components/ReviewScreen'));
const ExportScreen = lazy(() => import('./components/ExportScreen'));
const AdminDashboard = lazy(() => import('./components/AdminDashboard'));
const FeedbackScreen = lazy(() => import('./components/FeedbackScreen'));
const TermsScreen = lazy(() => import('./components/TermsScreen'));
const PrivacyScreen = lazy(() => import('./components/PrivacyScreen'));

function ScreenRouter() {
  const { screen, setScreen, status, warning, setWarning } = usePipeline();

  // Auto-dismiss soft warnings after 6s so they don't linger.
  useEffect(() => {
    if (!warning) return;
    const t = setTimeout(() => setWarning(null), 6000);
    return () => clearTimeout(t);
  }, [warning, setWarning]);
  const feedbackReturnRef = useRef(null);
  const skipPushRef = useRef(false);

  useEffect(() => {
    track('app_loaded', {
      device: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
      screen_width: window.innerWidth,
      screen_height: window.innerHeight,
    });
  }, []);

  // Push history state when screen changes (enables browser back button)
  useEffect(() => {
    if (skipPushRef.current) {
      skipPushRef.current = false;
      return;
    }
    // Replace on initial load, push on subsequent navigations
    const method = window.history.state?.screen ? 'pushState' : 'replaceState';
    window.history[method]({ screen }, '', window.location.pathname);
  }, [screen]);

  // Handle browser back/forward buttons
  useEffect(() => {
    const onPopState = (e) => {
      if (e.state?.screen) {
        skipPushRef.current = true;
        setScreen(e.state.screen);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [setScreen]);

  const openFeedback = (returnScreen) => {
    feedbackReturnRef.current = returnScreen || screen;
    setScreen('feedback');
  };

  return (
    <div className="app">
      <a href="#main-content" className="skip-nav">Skip to content</a>
      <Suspense fallback={null}>
        <div id="main-content">
          {screen === 'drop' && <><ThemeToggle /><DropZone /></>}
          {screen === 'review' && <ReviewScreen />}
          {screen === 'mask-edit' && <MaskEditorScreen />}
          {screen === 'export' && <ExportScreen onFeedback={() => openFeedback('export')} />}
          {screen === 'feedback' && <FeedbackScreen onBack={() => setScreen(feedbackReturnRef.current || 'drop')} />}
          {screen === 'admin' && <><ThemeToggle /><AdminDashboard onBack={() => setScreen('drop')} /></>}
        </div>
      </Suspense>
      {(status !== 'idle' && status !== 'ready' && status !== 'error') && <LoadingOverlay />}
      {status === 'error' && screen === 'drop' && <LoadingOverlay />}
      {warning && (
        <div className="app-toast" role="status" aria-live="polite">
          <span className="app-toast-body">{warning}</span>
          <button
            type="button"
            className="app-toast-close"
            aria-label="Dismiss notification"
            onClick={() => setWarning(null)}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

const pathname = window.location.pathname;

export default function App() {
  // Single place that owns SW registration + new-version detection.
  // Called here (not from ScreenRouter) so the toast is visible on every
  // route including /admin and /feedback.
  const { updateReady, applyUpdate, dismiss: dismissUpdate } = usePwaUpdate();

  useEffect(() => {
    const root = document.documentElement;
    // Capture the viewport ref once so the cleanup uses the exact same target
    // the subscription was attached to (guards against the reference flipping
    // to null between mount and unmount).
    const viewport = window.visualViewport || null;
    const syncViewportHeight = () => {
      const nextHeight = Math.round(viewport?.height ?? window.innerHeight);
      root.style.setProperty('--app-height', `${nextHeight}px`);
    };

    syncViewportHeight();
    window.addEventListener('resize', syncViewportHeight);
    window.addEventListener('orientationchange', syncViewportHeight);
    if (viewport) {
      viewport.addEventListener('resize', syncViewportHeight);
      viewport.addEventListener('scroll', syncViewportHeight);
    }

    return () => {
      window.removeEventListener('resize', syncViewportHeight);
      window.removeEventListener('orientationchange', syncViewportHeight);
      if (viewport) {
        viewport.removeEventListener('resize', syncViewportHeight);
        viewport.removeEventListener('scroll', syncViewportHeight);
      }
      root.style.removeProperty('--app-height');
    };
  }, []);

  const updatePrompt = (
    <UpdatePrompt
      visible={updateReady}
      onReload={applyUpdate}
      onDismiss={dismissUpdate}
    />
  );

  if (pathname === '/admin') {
    return (
      <Suspense fallback={null}>
        <ThemeToggle />
        <AdminDashboard />
        {updatePrompt}
      </Suspense>
    );
  }

  if (pathname === '/feedback') {
    return (
      <Suspense fallback={null}>
        <ThemeToggle />
        <FeedbackScreen onBack={() => { window.location.href = '/'; }} />
        {updatePrompt}
      </Suspense>
    );
  }

  if (pathname === '/terms') {
    return (
      <Suspense fallback={null}>
        <ThemeToggle />
        <TermsScreen onBack={() => { window.location.href = '/'; }} />
        {updatePrompt}
      </Suspense>
    );
  }

  if (pathname === '/privacy') {
    return (
      <Suspense fallback={null}>
        <ThemeToggle />
        <PrivacyScreen onBack={() => { window.location.href = '/'; }} />
        {updatePrompt}
      </Suspense>
    );
  }

  return (
    <PipelineProvider>
      <ScreenRouter />
      <InstallPrompt />
      {updatePrompt}
    </PipelineProvider>
  );
}
