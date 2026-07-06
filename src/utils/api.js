// Resolves backend endpoint URLs. On the web the path stays relative and
// resolves to the origin the page was loaded from (redactid.app in prod,
// localhost in dev). Inside a Capacitor native shell the WebView origin is
// `https://localhost` (Android) or `capacitor://localhost` (iOS), which has
// no concept of `/.netlify/functions/*` — those requests would get served
// the SPA fallback (index.html) and fail with "Unexpected token '<'" when
// the caller tries to .json() the response.
//
// On native we therefore prepend the absolute origin of the deployed site.
// The CORS headers configured in netlify.toml allow the cross-origin call
// to land successfully.
import { isNativeApp } from './platform';

// Production origin. Update only if the canonical site moves.
const NATIVE_API_ORIGIN = 'https://redactid.app';

export function apiUrl(path) {
  if (!isNativeApp()) return path;
  // In live-reload mode the WebView is loaded from a real http(s) URL
  // (the dev laptop's LAN IP / netlify dev port), so relative paths already
  // resolve to a working backend. Only prepend the prod origin when we're
  // running from the bundled local origin (https://localhost on Android,
  // capacitor://localhost on iOS) where /.netlify/functions/* would
  // otherwise hit the SPA fallback and return index.html.
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const isLocalBundle = /^https?:\/\/localhost(:|$|\/)/i.test(origin)
                     || /^capacitor:\/\//i.test(origin);
  return isLocalBundle ? `${NATIVE_API_ORIGIN}${path}` : path;
}
