const SESSION_KEY = 'ih_session_id';
const MAX_RETRIES = 2;
const RETRY_DELAY = 3000;

function getSessionId() {
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

function sendWithRetry(payload, attempt = 0) {
  fetch('/.netlify/functions/track', {
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
