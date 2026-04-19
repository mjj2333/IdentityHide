import { Component, useEffect, useRef, useState, lazy, Suspense } from 'react';
import { PipelineProvider, usePipeline } from './context/PipelineContext';
import { BatchProvider, useBatch } from './context/BatchContext';
import DropZone from './components/DropZone';
import LoadingOverlay from './components/LoadingOverlay';
import ThemeToggle from './components/ThemeToggle';
import InstallPrompt from './components/InstallPrompt';
import UpdatePrompt from './components/UpdatePrompt';
import ConfirmModal from './components/ConfirmModal';
import { usePwaUpdate } from './hooks/usePwaUpdate';
import { captureException } from './utils/sentry';
import './styles/global.css';

const MaskEditorScreen = lazy(() => import('./components/MaskEditorScreen'));
const ReviewScreen = lazy(() => import('./components/ReviewScreen'));
const ExportScreen = lazy(() => import('./components/ExportScreen'));
const BatchGridScreen = lazy(() => import('./components/BatchGridScreen'));
const BatchEditorScreen = lazy(() => import('./components/BatchEditorScreen'));
const BatchExportScreen = lazy(() => import('./components/BatchExportScreen'));
const AdminDashboard = lazy(() => import('./components/AdminDashboard'));
const FeedbackScreen = lazy(() => import('./components/FeedbackScreen'));
const TermsScreen = lazy(() => import('./components/TermsScreen'));
const PrivacyScreen = lazy(() => import('./components/PrivacyScreen'));
const FaqScreen = lazy(() => import('./components/FaqScreen'));

/**
 * Screen-level error boundary — catches crashes in lazy-loaded screens and
 * recovers to the drop screen instead of killing the entire app.
 */
class ScreenErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error, errorInfo) {
    captureException(error, { componentStack: errorInfo?.componentStack });
  }
  componentDidUpdate(prevProps) {
    // Reset when the screen changes (user navigated away via onRecover)
    if (prevProps.screenKey !== this.props.screenKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="screen-error">
          <p>Something went wrong on this screen.</p>
          <button className="btn btn-primary" onClick={this.props.onRecover}>
            Back to Start
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function ScreenRouter() {
  const { screen, setScreen, status, warning, setWarning } = usePipeline();
  const batch = useBatch();
  const { batchDirtyRef } = batch;

  // Auto-dismiss soft warnings after 6s. Sticky warnings (objects with
  // { message, sticky: true }) require manual dismiss via the × button.
  const warningText = typeof warning === 'string' ? warning : warning?.message;
  const warningSticky = typeof warning === 'object' && warning?.sticky;
  useEffect(() => {
    if (!warning || warningSticky) return;
    const t = setTimeout(() => setWarning(null), 6000);
    return () => clearTimeout(t);
  }, [warning, warningSticky, setWarning]);
  const feedbackReturnRef = useRef(null);
  const skipPushRef = useRef(false);

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

  // Target screen name when a browser-back off the batch editor is blocked
  // by unsaved edits. Non-null means the discard-confirm modal is showing.
  const [pendingNav, setPendingNav] = useState(null);

  // Handle browser back/forward buttons
  useEffect(() => {
    const onPopState = (e) => {
      if (!e.state?.screen) return;
      // Block browser-back off the batch editor when there are unsaved edits.
      // popstate can't be cancelled, so we re-push a batch-edit entry to undo
      // the browser's navigation, stash the target screen, and show a confirm
      // modal. On confirm we clear the dirty flag and call history.back() so
      // the original pop can complete cleanly through this same handler.
      if (
        screen === 'batch-edit' &&
        batchDirtyRef.current &&
        e.state.screen !== 'batch-edit'
      ) {
        window.history.pushState({ screen: 'batch-edit' }, '', window.location.pathname);
        setPendingNav(e.state.screen);
        return;
      }
      skipPushRef.current = true;
      setScreen(e.state.screen);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [setScreen, screen, batchDirtyRef]);


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
          <ScreenErrorBoundary screenKey={screen} onRecover={() => { batch.resetBatch(); setScreen('drop'); }}>
            {screen === 'review' && <ReviewScreen />}
            {screen === 'mask-edit' && <MaskEditorScreen />}
            {screen === 'export' && <ExportScreen onFeedback={() => openFeedback('export')} />}
            {screen === 'batch-grid' && <BatchGridScreen
              onBack={() => { batch.resetBatch(); setScreen('drop'); }}
              onExport={() => setScreen('batch-export')}
              onEditImage={(id) => { batch.setActiveImageId(id); setScreen('batch-edit'); }}
            />}
            {screen === 'batch-edit' && <BatchEditorScreen
              onBack={() => setScreen('batch-grid')}
            />}
            {screen === 'batch-export' && <BatchExportScreen
              onBack={() => setScreen('batch-grid')}
              onDone={() => { batch.resetBatch(); setScreen('drop'); }}
            />}
            {screen === 'feedback' && <FeedbackScreen onBack={() => setScreen(feedbackReturnRef.current || 'drop')} />}
            {screen === 'admin' && <><ThemeToggle /><AdminDashboard onBack={() => setScreen('drop')} /></>}
          </ScreenErrorBoundary>
        </div>
      </Suspense>
      {(status !== 'idle' && status !== 'ready' && status !== 'error') && <LoadingOverlay />}
      {status === 'error' && screen === 'drop' && <LoadingOverlay />}
      {warning && (
        <div className={`app-toast${warningSticky ? ' app-toast-sticky' : ''}`} role="status" aria-live="polite">
          <span className="app-toast-body">{warningText}</span>
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
      {pendingNav && (
        <ConfirmModal
          message="You have unsaved changes. Going back will discard them."
          confirmLabel="Discard"
          onConfirm={() => {
            batchDirtyRef.current = false;
            setPendingNav(null);
            // Pop the batch-edit entry we re-pushed. popstate re-fires this
            // handler with dirty=false, which takes the normal setScreen path.
            window.history.back();
          }}
          onCancel={() => setPendingNav(null)}
        />
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

  if (pathname === '/faq') {
    return (
      <Suspense fallback={null}>
        <ThemeToggle />
        <FaqScreen onBack={() => { window.location.href = '/'; }} />
        {updatePrompt}
      </Suspense>
    );
  }

  return (
    <PipelineProvider>
      <BatchProvider>
        <ScreenRouter />
        <InstallPrompt />
        {updatePrompt}
      </BatchProvider>
    </PipelineProvider>
  );
}
