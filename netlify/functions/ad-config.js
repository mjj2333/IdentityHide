/**
 * Ad config — read/write ad spot weights from Supabase.
 *
 * GET  → returns current config (no auth, used by vast-proxy)
 * POST → updates config (requires admin auth)
 *
 * Stored in Supabase table: ad_config (single row, key = 'weights')
 */

import { createClient } from '@supabase/supabase-js';
import { authenticateAdmin } from './auth.js';
import { rateLimit, checkOrigin } from './rateLimit.js';
import { withCors } from './_cors.js';

const CONFIG_KEY = 'weights';

// Default weights if nothing is stored yet
const DEFAULT_CONFIG = {
  spots: [
    { spot_id: '1488087', weight: 50, label: 'mainstream' },
    { spot_id: '1488306', weight: 50, label: 'mainstream 2' },
  ],
};

let supabase;
function getClient() {
  if (!supabase) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabase;
}

const adConfigHandler = async (event) => {
  // Rate-limit every request (including OPTIONS) to prevent endpoint enumeration
  // and to cap Supabase-read quota on the public GET path, which has no auth.
  const rl = await rateLimit(event, 10); // 10 req/min per IP
  if (rl.limited) return rl.response;

  // Preflight returns no CORS headers — cross-origin POST preflights fail here,
  // which is what we want. Same-origin requests from the admin UI don't trigger
  // a preflight so they proceed directly to the method branch.
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, body: '' };
  }

  const headers = { 'Content-Type': 'application/json' };
  const db = getClient();

  // GET — return current config (no auth, public read).
  // ACAO:* is kept here because the read is side-effect-free public data.
  if (event.httpMethod === 'GET') {
    headers['Access-Control-Allow-Origin'] = '*';
    try {
      const { data, error } = await db
        .from('ad_config')
        .select('value')
        .eq('key', CONFIG_KEY)
        .single();

      if (error || !data) {
        return { statusCode: 200, headers, body: JSON.stringify(DEFAULT_CONFIG) };
      }
      return { statusCode: 200, headers, body: JSON.stringify(data.value) };
    } catch {
      return { statusCode: 200, headers, body: JSON.stringify(DEFAULT_CONFIG) };
    }
  }

  // POST — update config (requires admin auth + same-origin)
  if (event.httpMethod === 'POST') {
    const og = checkOrigin(event);
    if (og.rejected) return og.response;
    const auth = await authenticateAdmin(event);
    if (auth.locked) {
      return {
        statusCode: 429,
        headers: { ...headers, 'Retry-After': String(auth.retryAfter) },
        body: JSON.stringify({ error: 'Too many failed login attempts — try again later' }),
      };
    }
    if (!auth.ok) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    try {
      const body = JSON.parse(event.body);
      if (!body.spots || !Array.isArray(body.spots)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing spots array' }) };
      }

      // Validate
      for (const spot of body.spots) {
        if (!spot.spot_id || typeof spot.weight !== 'number' || spot.weight < 0) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid spot config' }) };
        }
      }

      const config = { spots: body.spots };

      const { error } = await db
        .from('ad_config')
        .upsert({ key: CONFIG_KEY, value: config }, { onConflict: 'key' });

      if (error) throw error;

      return { statusCode: 200, headers, body: JSON.stringify(config) };
    } catch (err) {
      // Don't leak err.message to the client — Supabase errors can carry
      // table names, constraint names, or connection details. Log server-side,
      // return a generic message (consistent with the other functions).
      console.error('[ad-config] POST failed:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};

export const handler = withCors(adConfigHandler);
