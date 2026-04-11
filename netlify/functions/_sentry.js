// Shared Sentry init + handler wrapper for Netlify Functions.
//
// The leading underscore in the filename keeps Netlify from treating this as
// a deployable function entry point — it's only imported by the other
// handlers in this directory.

import * as Sentry from '@sentry/node';

let initialized = false;

function init() {
  if (initialized) return;
  initialized = true;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // No DSN means either the env var hasn't been set in Netlify yet, or
    // we're running locally. Either way, skip init and let the handlers
    // run normally without telemetry.
    return;
  }

  try {
    Sentry.init({
      dsn,
      // Netlify injects CONTEXT as 'production', 'deploy-preview', or
      // 'branch-deploy'. Falling back to 'production' so unknown
      // environments still get tagged.
      environment: process.env.CONTEXT || 'production',
      // Netlify injects COMMIT_REF as the git SHA of the deploy
      release: process.env.COMMIT_REF || 'unknown',
      sendDefaultPii: false,
      tracesSampleRate: 0,
      integrations: [],
    });
  } catch (e) {
    // Never let Sentry init break a function. If it fails we just lose
    // telemetry for that invocation.
    console.warn('[sentry:functions] init failed:', e?.message || e);
  }
}

/**
 * Wraps a Netlify function handler so any unhandled exception is reported to
 * Sentry before propagating. The wrapper preserves the handler's return value
 * on success, so wrapping is side-effect-free for happy-path requests.
 *
 * Usage:
 *   import { withSentry } from './_sentry.js';
 *   async function handler(event) { ... }
 *   export { withSentry as default };
 *   export const handler = withSentry(unwrapped);
 *
 * Critical: we await Sentry.flush() before rethrowing. Serverless functions
 * can freeze (and drop the in-flight transport) immediately after the handler
 * returns, so events queued during the handler would otherwise be lost.
 */
export function withSentry(handler) {
  init();
  return async function wrappedHandler(event, context) {
    try {
      return await handler(event, context);
    } catch (err) {
      try {
        Sentry.captureException(err);
        // 2s is enough on warm invocations; cold starts very rarely need more
        await Sentry.flush(2000);
      } catch {
        // Never let a telemetry failure change the original error behaviour
      }
      throw err;
    }
  };
}

/**
 * Explicit capture for handlers that already have their own try/catch and
 * return a 500 response instead of throwing. Used inside the existing inner
 * catches in track/feedback/admin-stats so those errors still land in Sentry
 * without us having to refactor every handler to re-throw.
 *
 * Fire-and-forget: does not await flush. The outer withSentry wrapper awaits
 * flush on throw, but for handled errors we rely on the SDK's background
 * transport and the next flush-on-shutdown to deliver the event. This keeps
 * the happy path cheap.
 */
export function captureException(err, extras) {
  init();
  try {
    Sentry.captureException(err, extras ? { extra: extras } : undefined);
  } catch {
    // Never let telemetry failures break a handler
  }
}
