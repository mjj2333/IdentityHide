import * as Sentry from '@sentry/react';

// DSN is hardcoded intentionally. Sentry DSNs are write-only public keys —
// anyone inspecting the bundled JS can read it, and that's by design. Putting
// it behind an env var would add setup friction for zero security benefit.
const DSN = 'https://df7f6b723c5cc3f491c2303e73cf43e9@o4511186341658625.ingest.us.sentry.io/4511186343165952';

// Replaced at build time by `define` in vite.config.js. Matches the sw.js
// CACHE_VERSION stamp so a given deploy's frontend errors and service worker
// can be correlated by release.
// eslint-disable-next-line no-undef
const BUILD_VERSION = typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'dev';

// Errors we drop before sending. These are all expected noise for Redact.ID
// specifically — they either represent user actions (cancel), browser quirks
// (ResizeObserver), known-and-surfaced conditions (storage full), or things we
// can't do anything about (third-party extensions).
const IGNORE_ERRORS = [
  // User-cancelled ComfyUI operations, file pickers, etc.
  'AbortError',
  'The operation was aborted',
  // Benign Chrome/Safari noise that fires during layout thrash
  'ResizeObserver loop limit exceeded',
  'ResizeObserver loop completed with undelivered notifications',
  // IndexedDB full — already surfaced to user via the warning toast in
  // PipelineContext's auto-save effect
  'QuotaExceededError',
  // Usually a bare throw of a non-Error; our code shouldn't produce these and
  // Sentry's default capture is too noisy for them
  'Non-Error promise rejection captured',
];

const DENY_URLS = [
  // Browser extensions injecting scripts into our page
  /extensions\//i,
  /^chrome-extension:\/\//i,
  /^moz-extension:\/\//i,
  /^safari-extension:\/\//i,
  /^chrome:\/\//i,
  /^about:/i,
];

/**
 * Strip anything from an event that could leak user content. Called by Sentry
 * right before transport.
 *
 * Key concerns for Redact.ID:
 *  - Pasted images arrive as blob: URLs. Don't send request.url at all.
 *  - File names ("family-vacation-2024.jpg") are PII. Don't leak them.
 *  - Canvas content must never appear — our pipeline doesn't log base64 but
 *    defensively drop any breadcrumb whose data looks like image bytes.
 *  - Typed user input (feedback form, paste events) is captured as ui.input
 *    breadcrumbs by default. Drop the category entirely.
 */
function scrubEvent(event) {
  // Drop the request URL — on our app it's a blob:/file: URL or pathname that
  // could carry a session-identifying hash. The release tag is enough context.
  if (event.request) {
    delete event.request.url;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.data;
  }

  // Drop input-category breadcrumbs entirely. These capture keystrokes in
  // form fields (feedback form content, admin password, etc.).
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.filter((b) => {
      if (!b) return false;
      if (b.category === 'ui.input') return false;
      // Drop any breadcrumb whose message looks like image data
      const msg = typeof b.message === 'string' ? b.message : '';
      if (msg.length > 2000) return false;
      if (msg.includes('data:image')) return false;
      if (msg.includes('blob:')) return false;
      return true;
    });
  }

  // Drop any file-name hints from exception values. This is a belt-and-braces
  // check — our code shouldn't throw errors that embed file names, but third-
  // party libraries sometimes do.
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (typeof ex.value === 'string') {
        ex.value = ex.value
          .replace(/blob:[^\s'"]+/g, '[blob]')
          .replace(/data:image\/[^\s'"]+/g, '[image]');
      }
    }
  }

  return event;
}

let initialized = false;

export function initSentry() {
  if (initialized) return;
  initialized = true;

  try {
    Sentry.init({
      dsn: DSN,
      environment: import.meta.env.MODE, // 'development' or 'production'
      release: BUILD_VERSION,
      sendDefaultPii: false,
      // No performance tracing — option 2 from the design, keeps event volume
      // well under the free-tier cap and avoids any browser-tracing
      // autoinstrumentation that could capture fetch bodies
      tracesSampleRate: 0,
      // No session replay — product-trust issue for a privacy-focused app
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      integrations: [],
      ignoreErrors: IGNORE_ERRORS,
      denyUrls: DENY_URLS,
      beforeSend: scrubEvent,
      // Skip Sentry entirely in dev — local stack traces + console are more
      // useful than a remote dashboard, and we don't want dev noise
      // polluting prod data
      enabled: import.meta.env.MODE === 'production',
    });
  } catch (e) {
    // Never let Sentry init break the app. If init fails (DSN rejected, CSP
    // blocks the transport, etc.), the app should load normally without
    // telemetry.
    console.warn('[sentry] init failed:', e?.message || e);
  }
}

/**
 * Thin wrapper so callers don't have to import Sentry directly.
 * Extra context is attached as tags / extras when provided.
 */
export function captureException(error, extras) {
  try {
    Sentry.captureException(error, extras ? { extra: extras } : undefined);
  } catch {
    // Swallow — capture must never throw into user code
  }
}
