# PWA Update Notifications

## Problem
When a new version of IdentityHide is deployed, installed PWA users have no way to
know. The current service worker calls `self.skipWaiting()` unconditionally in its
`install` handler, so a new SW silently activates behind a page that keeps running
the old JS bundles. Users must close/reopen the PWA (or, per the user report,
uninstall and reinstall) to pick up changes.

## Goal
Detect when a new service worker has finished installing and is waiting to take
over, then show a non-intrusive toast with a "Reload" button so the user can apply
the update at a moment that works for them.

## Approach
Standard PWA update flow:

1. Remove auto `skipWaiting()` so a new SW sits in the `waiting` state until the
   client explicitly tells it to take over.
2. Client-side hook registers the SW, listens for `updatefound`, and flips a
   React state flag when a new worker reaches `installed` while an existing
   controller is in charge.
3. Toast component reads that flag and renders a bottom-center pill with
   "New version available" + Reload button + dismiss (×).
4. On Reload: `postMessage({type: 'SKIP_WAITING'})` to the waiting worker, listen
   for `controllerchange`, then `window.location.reload()`.
5. In-progress work is already protected by the existing IndexedDB auto-save
   (`sessionStore.js`) — the Resume banner will offer to restore after reload.

## Check cadence
The hook triggers update checks at three points, all cheap:
- **On mount** — `navigator.serviceWorker.register('/sw.js')` already checks.
  Additionally, if `registration.waiting` is truthy at mount time (e.g., the
  user previously dismissed the toast and reloaded, and the SW is still
  waiting), the hook flips `updateReady = true` immediately without waiting
  for a fresh `updatefound` event.
- **On visibilitychange → visible** — `registration.update()`. Catches the common
  case where the user backgrounds the PWA for a while and comes back.
- **Every 60 minutes while the tab is open** — `setInterval` fallback for
  long-running sessions. Cleared on unmount.

## Files

### New
- `src/hooks/usePwaUpdate.js` — registration, update detection, visibility +
  interval checks, exposes `{ updateReady, applyUpdate, dismiss }`
- `src/components/UpdatePrompt.jsx` — bottom-center toast, conditional on
  `updateReady`
- `src/styles/UpdatePrompt.css` — toast visuals, slide-up entrance,
  `prefers-reduced-motion` respected

### Modified
- `public/sw.js`
  - Remove `self.skipWaiting()` from the `install` handler
  - Add `message` handler: `if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()`
  - `clients.claim()` in `activate` stays as-is
- `index.html` — remove inline SW registration script (hook owns it now). The
  `beforeinstallprompt` capture stays.
- `src/App.jsx` — call `usePwaUpdate()` at the top level, render `<UpdatePrompt />`

## Component interface

### `usePwaUpdate()`
```js
function usePwaUpdate() {
  // returns { updateReady: boolean, applyUpdate: () => void, dismiss: () => void }
}
```
- `updateReady` — true when a new SW is waiting. False initially and after dismiss.
- `applyUpdate()` — postMessage SKIP_WAITING, reload on controllerchange (once).
- `dismiss()` — sets updateReady false for the rest of this session. Next cold
  start, if the SW is still waiting, the flag comes back true.

### `<UpdatePrompt />`
No props. Reads state from the hook via its own `usePwaUpdate()` call, OR the App
calls `usePwaUpdate()` once and passes the values down. (Decision: App owns the
hook, passes props, so we don't register the SW twice.)

```jsx
<UpdatePrompt
  visible={updateReady}
  onReload={applyUpdate}
  onDismiss={dismiss}
/>
```

## Edge cases
- **First-ever install** — no existing `navigator.serviceWorker.controller`, so
  the hook treats the `installed` transition as "initial install, not an update"
  and stays quiet.
- **Reload loop** — guard `controllerchange` handler with a `refreshing` flag so
  we only call `reload()` once, even if the event fires multiple times.
- **SW registration fails** — hook catches errors and stays silent (matches
  current behavior, which ignores registration failures).
- **User dismisses, then a newer SW arrives** — `updatefound` fires again,
  `updateReady` flips back to true, toast reappears.
- **User is on the drop zone / restore banner flow** — toast is non-blocking,
  positioned at bottom-center, so it doesn't conflict with existing banners.

## Analytics
Using the existing `track()` helper:
- `track('pwa_update_available')` once per toast appearance
- `track('pwa_update_applied')` on Reload click
- `track('pwa_update_dismissed')` on × click

## Accessibility
- Toast has `role="status"` + `aria-live="polite"` so screen readers announce it
  without interrupting whatever the user is doing
- Reload button is a real `<button>` with a clear label
- Dismiss button has `aria-label="Dismiss update notification"`
- Escape key while the toast has focus dismisses it
- `prefers-reduced-motion` suppresses the slide-up entrance

## Verification
1. `npx vite build` — no errors
2. `npx netlify deploy --dir=dist --functions=netlify/functions` — draft deploy
3. Open draft URL on desktop, install as PWA
4. Make a trivial change (e.g., bump a version string), rebuild, redeploy draft
5. Reopen the installed PWA within 60s or after visibility change — toast should
   appear at bottom-center
6. Click Reload — page refreshes, session auto-save should restore any in-progress
   work via the existing Resume banner
7. Verify analytics events fire in network tab
8. Test × dismiss — toast disappears, doesn't reappear within this session
9. Light mode + reduced motion — toast still readable, no entrance animation

## Rollout notes
- First deploy of this change: existing installed users still running the old SW
  will auto-activate the new SW (because the OLD SW has `skipWaiting()`). The
  next deploy after that is when the new update flow actually kicks in.
- No config changes, no new env vars.
