const SESSION_KEY = 'ih_session_id';
const MAX_RETRIES = 2;
const RETRY_DELAY = 3000;

// Build a UUID v4 from CSPRNG bytes. Used when crypto.randomUUID() is
// unavailable (older browsers, insecure contexts on some engines).
// crypto.getRandomValues() is available in insecure contexts too, so this
// path keeps the session_id unpredictable without requiring HTTPS.
function uuidFromRandomBytes() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function generateSessionId() {
  try { if (crypto.randomUUID) return crypto.randomUUID(); } catch {}
  try { return uuidFromRandomBytes(); } catch {}
  // Last resort — only reached if neither crypto API is exposed at all.
  // Not cryptographically strong, but keeps the app functional.
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function getSessionId() {
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = generateSessionId();
    sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

import { apiUrl } from './api';

function sendWithRetry(payload, attempt = 0) {
  fetch(apiUrl('/.netlify/functions/track'), {
    method: 'POST',
    body: payload,
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
  }).then(res => {
    // Surface server-side rejections (e.g. 400 invalid event) so silent drops are visible.
    // 4xx are not retried — they indicate a client/payload problem, not a transient error.
    if (!res.ok && res.status !== 429) {
      console.warn(`[analytics] track rejected: ${res.status}`);
    }
  }).catch(() => {
    if (attempt < MAX_RETRIES) {
      setTimeout(() => sendWithRetry(payload, attempt + 1), RETRY_DELAY * (attempt + 1));
    }
  });
}

export function track(event, properties = {}) {
  if (import.meta.env.DEV) {
    console.log(`[analytics] ${event}`, properties);
    return;
  }

  const payload = JSON.stringify({
    session_id: getSessionId(),
    event,
    properties,
    referrer: document.referrer || null,
  });

  try {
    sendWithRetry(payload);
  } catch {
    // Silently fail — never block the UI
  }
}
