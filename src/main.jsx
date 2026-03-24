import React, { StrictMode, Component, useState } from 'react'
import ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'

// ── Diagnostic: detect duplicate React instances ──
console.log('=== React Diagnostics ===');
console.log('React version:', React.version);
console.log('ReactDOM version:', ReactDOM.version);
console.log('React object id:', typeof React, Object.keys(React).length, 'keys');
console.log('React.useState:', typeof React.useState);
console.log('useState (direct import):', typeof useState);
console.log('React.useState === useState:', React.useState === useState);

// Check if react-dom is using the same React
try {
  const reactFromDOM = ReactDOM.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  console.log('ReactDOM internals available:', !!reactFromDOM);
} catch (e) {
  console.error('Could not access ReactDOM internals:', e);
}

// ── Quick hook test before loading the full app ──
function HookTest() {
  try {
    const [x] = useState(42);
    return React.createElement('div', { style: { display: 'none' } }, 'hook-test-' + x);
  } catch (e) {
    console.error('!!! HOOK TEST FAILED !!!', e.message);
    document.getElementById('root').innerHTML =
      '<div style="color:red;padding:40px;font-family:monospace;white-space:pre-wrap">' +
      '<h2>React Hook Error Diagnostic</h2>' +
      '<p>useState failed: ' + e.message + '</p>' +
      '<p>React version: ' + React.version + '</p>' +
      '<p>ReactDOM version: ' + ReactDOM.version + '</p>' +
      '</div>';
    throw e;
  }
}

// ── Error Boundary ──
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, errorInfo: null };
  }
  componentDidCatch(error, errorInfo) {
    this.setState({ error, errorInfo });
    console.error('=== ErrorBoundary caught ===');
    console.error('Error:', error);
    console.error('Component stack:', errorInfo?.componentStack);
  }
  render() {
    if (this.state.error) {
      return React.createElement('div', {
        style: { color: '#ff4466', padding: 40, fontFamily: 'monospace', whiteSpace: 'pre-wrap', background: '#0a0a0f', minHeight: '100vh' }
      },
        React.createElement('h2', null, 'PixelShield Error'),
        React.createElement('p', null, 'Error: ' + this.state.error.message),
        React.createElement('pre', { style: { fontSize: 12, color: '#888', marginTop: 20, overflow: 'auto' } },
          this.state.errorInfo?.componentStack || 'No component stack available'
        ),
        React.createElement('pre', { style: { fontSize: 12, color: '#666', marginTop: 10, overflow: 'auto' } },
          this.state.error.stack || ''
        )
      );
    }
    return this.props.children;
  }
}

// ── Lazy-load the real app so we can catch import errors ──
console.log('Loading App module...');
import('./App.jsx').then((mod) => {
  console.log('App module loaded successfully');
  const App = mod.default;

  createRoot(document.getElementById('root')).render(
    React.createElement(ErrorBoundary, null,
      React.createElement(HookTest),
      React.createElement(App)
    )
  );
  console.log('Render called successfully');
}).catch((err) => {
  console.error('Failed to load App module:', err);
  document.getElementById('root').innerHTML =
    '<div style="color:red;padding:40px;font-family:monospace;white-space:pre-wrap">' +
    '<h2>Module Load Error</h2>' +
    '<pre>' + err.stack + '</pre></div>';
});
