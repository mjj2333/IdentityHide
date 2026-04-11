// Sliding-window rate limiter backed by Netlify Blobs (persistent across cold starts
// and shared across function instances, unlike a module-scope Map).
import { getStore } from '@netlify/blobs';

let store;
function getRateLimitStore() {
  if (!store) store = getStore('rate-limits');
  return store;
}

// Max attempts for the compare-and-swap loop below. 3 is plenty — the blob
// store arbitrates writes via ETag preconditions, so even a burst of N
// concurrent requests converges in O(log N) retries in practice.
const MAX_CAS_RETRIES = 3;

/**
 * @param {object} event   Netlify function event
 * @param {number} limit   Max requests per window
 * @param {number} windowMs  Window duration in ms (default 60s)
 * @returns {Promise<{ limited: boolean, response?: object }>}
 */
export async function rateLimit(event, limit, windowMs = 60_000) {
  // Trust only Netlify's edge-injected client IP header. x-forwarded-for is
  // client-controlled and would let an attacker forge a fresh "IP" per request
  // to bypass the limit entirely.
  const ip = event.headers['x-nf-client-connection-ip'] || 'unknown';

  const now = Date.now();
  const key = `ip:${ip}`;

  let entry;
  try {
    const s = getRateLimitStore();
    // Compare-and-swap loop. A plain get->mutate->set sequence races under
    // concurrent requests from the same IP: two requests both read count=N,
    // both write count=N+1, and the second write clobbers the first — one
    // request slips past the limit. Using `onlyIfMatch: etag` (or `onlyIfNew`
    // when the key doesn't exist yet) makes the write conditional on the
    // state we read, so a loser retries with the fresh value.
    let modified = false;
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const result = await s.getWithMetadata(key, { type: 'json' });
      const existing = result?.data;
      const etag = result?.etag;

      if (!existing || now - existing.start > windowMs) {
        entry = { count: 1, start: now };
      } else {
        entry = { count: existing.count + 1, start: existing.start };
      }

      const writeOptions = {
        // TTL via metadata: blob auto-expires shortly after the window ends.
        metadata: { expires: entry.start + windowMs * 2 },
      };
      if (etag) {
        writeOptions.onlyIfMatch = etag;
      } else {
        writeOptions.onlyIfNew = true;
      }

      const write = await s.setJSON(key, entry, writeOptions);
      if (write.modified) {
        modified = true;
        break;
      }
      // Precondition failed — another request raced us. Re-read on next pass.
    }

    if (!modified) {
      // Fall-open after exhausting retries. Under sustained contention we'd
      // rather let the request through than throw on legitimate users; the
      // attacker still has to fight the CAS loop for every request, and the
      // blob store's own rate limits kick in above our layer.
      console.warn(`rateLimit CAS retries exhausted for ${key}`);
      return { limited: false };
    }
  } catch (err) {
    // Fail-open: if the blob store is unavailable, allow the request rather than
    // breaking the function entirely. Logged for visibility.
    console.error('rateLimit store error:', err);
    return { limited: false };
  }

  if (entry.count > limit) {
    const retryAfter = Math.ceil((entry.start + windowMs - now) / 1000);
    return {
      limited: true,
      response: {
        statusCode: 429,
        headers: { 'Retry-After': String(retryAfter) },
        body: 'Too many requests',
      },
    };
  }

  return { limited: false };
}

const ALLOWED_ORIGINS = [
  'https://identityhide.netlify.app',
  'https://identity-hide.com',
];

// Netlify draft/preview deploys live at https://<hash>--identityhide.netlify.app
// — allow any origin that matches the site's preview subdomain pattern so the
// admin UI works on draft URLs without having to enumerate each one.
const PREVIEW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+--identityhide\.netlify\.app$/;

// Accept any localhost/127.0.0.1 origin regardless of port. Vite and
// netlify dev pick whatever port is free (5173/5174/5176/8888/...), so
// hard-coding a single port breaks the moment a dev runs on a new one.
const LOCALHOST_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function isAllowedOrigin(source) {
  if (!source) return false;
  if (ALLOWED_ORIGINS.includes(source)) return true;
  if (PREVIEW_ORIGIN_RE.test(source)) return true;
  if (LOCALHOST_ORIGIN_RE.test(source)) return true;
  return false;
}

/**
 * Validates Origin/Referer header against allowed origins.
 * @param {object} event  Netlify function event
 * @returns {{ rejected: boolean, response?: object }}
 */
export function checkOrigin(event) {
  const origin = event.headers['origin'];
  const referer = event.headers['referer'];

  // Reject requests that carry neither header. All legitimate callers are
  // browser fetch() POSTs from the app, which always send Origin. A request
  // with no Origin and no Referer is a script/CLI tool trying to bypass the
  // origin allowlist, not a real user.
  if (!origin && !referer) {
    return {
      rejected: true,
      response: { statusCode: 403, body: 'Forbidden' },
    };
  }

  let source = origin;
  if (!source && referer) {
    try {
      source = new URL(referer).origin;
    } catch {
      return {
        rejected: true,
        response: { statusCode: 403, body: 'Forbidden' },
      };
    }
  }
  if (isAllowedOrigin(source)) return { rejected: false };

  return {
    rejected: true,
    response: { statusCode: 403, body: 'Forbidden' },
  };
}
