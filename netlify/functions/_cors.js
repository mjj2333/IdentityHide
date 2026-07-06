// Shared CORS handling for Netlify Functions.
//
// Netlify's netlify.toml `[[headers]]` block applies to static assets only,
// not Function responses — so the functions have to attach their own CORS
// headers. This helper wraps a handler, transparently:
//   1. Short-circuits OPTIONS preflight with the right headers
//   2. Decorates every response with Access-Control-Allow-* on the way out
//
// Why we allow `*` instead of echoing the origin: this app does not use
// credentialed requests (no cookies — admin auth is Authorization: Bearer,
// entitlement is plain GET). With no credentials the wildcard works for any
// caller, and the actual auth boundary is rateLimit + checkOrigin +
// password lockout in the function itself, not CORS.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
};

function mergeHeaders(existing) {
  return { ...CORS_HEADERS, ...(existing || {}) };
}

/**
 * Wraps a Netlify function handler so all responses include CORS headers
 * and OPTIONS preflight returns 204 without invoking the inner handler.
 *
 *   export const handler = withCors(withSentry(myHandler));
 *
 * Order matters: withCors should be the outermost wrap so preflight is
 * answered cheaply (no Sentry overhead) and every error response — even
 * those from withSentry — still carries CORS headers.
 */
export function withCors(handler) {
  return async function corsWrapped(event, context) {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: { ...CORS_HEADERS }, body: '' };
    }
    const response = await handler(event, context);
    if (!response || typeof response !== 'object') return response;
    return {
      ...response,
      headers: mergeHeaders(response.headers),
    };
  };
}
