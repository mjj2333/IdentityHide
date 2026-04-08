# Sentry Error Tracking

## Problem
When something goes wrong in production — a React component crashes, a Netlify
function 500s, or a promise rejects unhandled — we have no visibility. Users
either work around it silently or hit a blank screen and bail. We need real
error telemetry before we can do "detailed error checking" in any meaningful way.

## Goal
Wire up Sentry so both the frontend React app and the Netlify function handlers
report unhandled errors to a hosted dashboard, without leaking user data from an
app whose whole value proposition is "your photos never leave your device".

## Scope
Option 2 from the brainstorming session:
- Frontend JS runtime errors, unhandled promise rejections, React error boundary
  captures
- All Netlify function handler exceptions (`track`, `feedback`, `admin-stats`)
- **Not** included: session replay, performance traces, browser tracing,
  autoinstrumentation of fetch bodies, user identification beyond anon session id

## Privacy stance
IdentityHide is a privacy-first app. Default Sentry behaviour (send IP, capture
form inputs in breadcrumbs, capture full URLs) is incompatible with that stance.
We override:
- `sendDefaultPii: false` — no IP capture
- `beforeSend` scrubber drops `request.url`, `ui.input` breadcrumbs, and any
  breadcrumb whose content looks like a base64 image or blob URL
- `ignoreErrors` drops expected noise: `AbortError`, `ResizeObserver loop`,
  `QuotaExceededError`, browser extension errors
- No user identification (no email, no name). Optional anon session id only.
- Canvas, image blobs, and filenames never touch an error report

## Files

### New
- `src/utils/sentry.js` — frontend init, `captureException` helper, privacy
  scrubber, error allowlist
- `netlify/functions/_sentry.js` — shared init + `withSentry(handler)` wrapper.
  Underscore prefix makes Netlify skip it as a function entry point.

### Modified
- `src/main.jsx` — call `initSentry()` before `createRoot`; update
  `ErrorBoundary.componentDidCatch` to also call `captureException`
- `vite.config.js` — inject `__BUILD_VERSION__` via `define` so frontend errors
  are tagged with the release (reuses the same timestamp as `sw.js`)
- `netlify/functions/track.js` — wrap `handler` with `withSentry`
- `netlify/functions/feedback.js` — wrap `handler` with `withSentry`
- `netlify/functions/admin-stats.js` — wrap `handler` with `withSentry`
- `package.json` (root) — add `@sentry/react`
- `netlify/functions/package.json` — add `@sentry/node`

## DSN handling
- **Frontend DSN** is hardcoded in `src/utils/sentry.js`. Sentry DSNs are
  write-only public keys — they can be read from the bundled JS by any user, and
  this is by design. Putting it in an env var would add setup friction for zero
  security benefit.
- **Backend DSN** is read from `process.env.SENTRY_DSN` at runtime. The same DSN
  value as the frontend; user adds it in the Netlify dashboard after this lands.

## Release tagging
- Frontend: `release: __BUILD_VERSION__` from `vite define`, formatted as
  `b${Date.now().toString(36)}` to match the existing `sw.js` stamp. Same
  version lets us correlate "this error started after the b... deploy".
- Backend: `release: process.env.COMMIT_REF`, which Netlify injects automatically
  from git. Mismatch with frontend is OK — both get a per-deploy tag, which is
  all that matters for "when did this start".

## Environment separation
- `environment: import.meta.env.MODE` on the frontend → `development` locally,
  `production` in prod builds
- `environment: process.env.CONTEXT || 'production'` on the backend → Netlify
  injects `deploy-preview`, `branch-deploy`, or `production`

## Error filtering (`ignoreErrors`)
Dropped as expected noise:
- `AbortError` — user-cancelled ComfyUI operations
- `ResizeObserver loop limit exceeded` — benign browser noise
- `Non-Error promise rejection captured` — already handled elsewhere
- `QuotaExceededError` — IndexedDB full, already surfaced to user via warning toast
- `NetworkError` from `/uploadImage` and `/uploadMask` paths — user offline,
  already surfaced by the existing error UI
- Browser extension errors via `denyUrls: [/extensions\//i, /^chrome:\/\//i]`

## ErrorBoundary integration
`src/main.jsx` already has a custom `ErrorBoundary` with a nice fallback UI.
We keep that UI as-is and only add a single `captureException(error, { componentStack: errorInfo.componentStack })` call inside `componentDidCatch`. We
explicitly don't replace the class with Sentry's `Sentry.ErrorBoundary` because
that would lose the existing UI and add unnecessary indirection.

## Testing plan
1. `npx vite build` — no errors, bundle delta < 50KB for `@sentry/react`
2. `npx netlify deploy --dir=dist --functions=netlify/functions` — draft deploy
3. Open draft URL, open devtools console, run `throw new Error('sentry test')`
4. Confirm event shows in Sentry dashboard within ~10s, tagged with release
5. Verify `request.url` is absent or empty in the event (privacy scrub working)
6. Trigger a function error: temporarily POST malformed JSON to `/.netlify/functions/track` that passes the JSON.parse but fails the DB insert. Confirm it lands in Sentry tagged with `environment: production` (or `deploy-preview` on draft)
7. Verify no PII, no filename, no image data in either event

## Post-deploy user actions
1. In Netlify dashboard → Site → Environment variables → add:
   - `SENTRY_DSN` = `https://df7f6b723c5cc3f491c2303e73cf43e9@o4511186341658625.ingest.us.sentry.io/4511186343165952`
2. Trigger a redeploy (functions need the env var baked in)
3. Run the manual test from the testing plan

## Out of scope (for follow-up)
- Fixing the `VALID_EVENTS` allowlist in `track.js`, which is missing the
  `tier_*` and `pwa_update_*` events I've added in prior sessions. Those are
  being silently 400'd by the server. Worth flagging but not part of Sentry.
- Source map uploads for de-minified stack traces. Useful later, but adds
  build-time setup and can be added once we confirm the basics are working.
