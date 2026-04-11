import { createClient } from '@supabase/supabase-js';
import { rateLimit, checkOrigin } from './rateLimit.js';
import { withSentry, captureException } from './_sentry.js';

// Server-side allowlist of event names the client is permitted to emit.
// THIS IS THE SOURCE OF TRUTH — if you add a new `track('foo', ...)` call in
// the client, you MUST add 'foo' here or the server will 400 it and the event
// will be dropped silently from analytics. There is no client-side constant
// to keep in sync; the list of valid events lives only here. To audit drift,
// grep the frontend: `rg "track\(['\"]" src/` and compare against this array.
const VALID_EVENTS = [
  'app_loaded', 'image_uploaded', 'mask_editor_entered', 'apply_clicked',
  'skip_clicked', 'review_entered', 'export_completed', 'blur_mode_changed',
  'comfyui_completed', 'comfyui_failed', 'start_over',
  'face_auto_detect', 'blur_region_added', 'review_back', 'review_touch_up',
  'walkthrough_seen', 'walkthrough_completed', 'walkthrough_skipped',
  'pwa_update_available', 'pwa_update_applied', 'pwa_update_dismissed',
  'tier_selected', 'tier_modal_cancelled', 'tier_disabled_shown',
];

// Input limits. These are enforced with a 400 response (not silent
// truncation) so clients get a clear signal if they're generating oversized
// payloads — a silent truncate would mask real bugs in the tracking code.
const MAX_SESSION_ID_LEN = 100;    // matches `events.session_id` column width
const MAX_PROPERTIES_JSON = 2048;  // JSON-serialized property blob cap
const MAX_REFERRER_LEN = 500;      // matches `events.referrer` column width

let supabase;
function getClient() {
  if (!supabase) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabase;
}

async function trackHandler(event) {
  // Rate-limit every request (including OPTIONS) to prevent endpoint enumeration
  const rl = await rateLimit(event, 60); // 60 events/min per IP
  if (rl.limited) return rl.response;

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const og = checkOrigin(event);
  if (og.rejected) return og.response;

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  try {
    const { session_id, event: eventName, properties, referrer } = body;

    if (!session_id || typeof session_id !== 'string' || session_id.length > MAX_SESSION_ID_LEN) {
      return { statusCode: 400, body: 'Invalid payload' };
    }
    if (!eventName || !VALID_EVENTS.includes(eventName)) {
      return { statusCode: 400, body: 'Invalid payload' };
    }

    let safeProps = {};
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      const json = JSON.stringify(properties);
      if (json.length > MAX_PROPERTIES_JSON) {
        return { statusCode: 413, body: 'Properties payload too large' };
      }
      safeProps = properties;
    }

    const referrerStr = referrer ? String(referrer) : null;
    if (referrerStr && referrerStr.length > MAX_REFERRER_LEN) {
      return { statusCode: 413, body: 'Referrer too long' };
    }

    const { error } = await getClient().from('events').insert({
      session_id,
      event: eventName,
      properties: safeProps,
      user_agent: event.headers['user-agent'] || null,
      referrer: referrerStr,
    });

    if (error) {
      console.error('Supabase insert error:', error);
      captureException(error, { scope: 'track.supabase_insert' });
      return { statusCode: 500, body: 'DB error' };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: 'OK',
    };
  } catch (err) {
    console.error('Track error:', err);
    captureException(err, { scope: 'track.unhandled' });
    return { statusCode: 500, body: 'Server error' };
  }
}

export const handler = withSentry(trackHandler);
