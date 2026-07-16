import { Component } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { initSentry, captureException } from './utils/sentry.js'
import { getNativePlatform } from './utils/platform.js'

// Self-hosted fonts (bundled via @fontsource-variable). Loading here once
// so Fraunces/Inter/JetBrains Mono are available everywhere the app
// references them via CSS variables (`--serif`, `--sans`, `--mono`).
// No third-party requests — all font bytes are served from the app's own
// origin, consistent with the privacy-first posture.
import '@fontsource-variable/fraunces';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';

// Initialize Sentry before the app mounts so the very earliest runtime errors
// (e.g. module-level throws in a lazy chunk) get captured.
initSentry();

// Tag <html> with the native platform ('platform-ios' / 'platform-android') at
// startup so CSS can scope platform-specific fixes (e.g. iOS home-indicator /
// toolbar safe-area quirks) WITHOUT touching the web PWA or the other native
// platform. No class is added on the web, so PWA styling is unchanged.
const nativePlatform = getNativePlatform();
if (nativePlatform) {
  document.documentElement.classList.add(`platform-${nativePlatform}`);
}

// ── Error Boundary ──
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  componentDidCatch(error, errorInfo) {
    this.setState({ error });
    console.error('Uncaught error:', error);
    console.error('Component stack:', errorInfo?.componentStack);
    // Report the crash to Sentry with the React component stack attached.
    // Kept as a one-liner so the existing fallback UI stays in charge — we
    // deliberately don't use Sentry.ErrorBoundary here because it would
    // replace the custom UI with its own.
    captureException(error, { componentStack: errorInfo?.componentStack });
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ color: '#ff4466', padding: 40, fontFamily: 'system-ui, sans-serif', background: '#0a0a0a', minHeight: '100vh' }}>
          <h2>Something went wrong</h2>
          <p style={{ color: '#aaa' }}>Please refresh the page or try again later.</p>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: '8px 20px', background: '#e8384f', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14 }}
          >
            Refresh
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Range slider fill color ──
const updateSliderFill = (el) => {
  const pct = (el.value - el.min) / (el.max - el.min) * 100;
  el.style.setProperty('--slider-pct', `${pct}%`);
};
document.addEventListener('input', (e) => {
  if (e.target.matches('input[type="range"]')) updateSliderFill(e.target);
}, true);
// Cache the root element once and guard it — both the MutationObserver and
// createRoot throw if passed null, and a missing #root should fail loudly in
// the console rather than silently crashing the module.
const rootElement = document.getElementById('root');
if (!rootElement) {
  console.error('[main] #root element not found — app cannot mount');
} else {
  new MutationObserver(() => {
    document.querySelectorAll('input[type="range"]').forEach(updateSliderFill);
  }).observe(rootElement, { childList: true, subtree: true });

  // ── Render ──
  createRoot(rootElement).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
