import { createClient } from '@supabase/supabase-js';
import { rateLimit, checkOrigin } from './rateLimit.js';
import { authenticateAdmin } from './auth.js';
import { withSentry, captureException } from './_sentry.js';

let supabase;
function getClient() {
  if (!supabase) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabase;
}

const FUNNEL_ORDER = [
  'app_loaded', 'image_uploaded', 'mask_editor_entered',
  'apply_clicked', 'review_entered', 'export_completed',
];

async function adminStatsHandler(event) {
  // Rate-limit every request (including OPTIONS) to prevent endpoint enumeration
  const rl = await rateLimit(event, 10); // 10 req/min per IP
  if (rl.limited) return rl.response;

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const og = checkOrigin(event);
  if (og.rejected) return og.response;

  const auth = await authenticateAdmin(event);
  if (auth.locked) {
    return {
      statusCode: 429,
      headers: { 'Retry-After': String(auth.retryAfter) },
      body: 'Too many failed login attempts — try again later',
    };
  }
  if (!auth.ok) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  try {
    const now = new Date();
    const since60dAgo = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString();

    // Fetch all events from last 60 days (for trend comparison).
    // Supabase/PostgREST caps single queries at 1000 rows, so we must paginate
    // to retrieve everything in the window. Runaway guard: max 50 pages = 50k rows.
    // Per-page soft timeout and overall deadline prevent the loop from
    // running past the Lambda execution cap.
    const PAGE_SIZE = 1000;
    const MAX_PAGES = 50;
    const PAGE_TIMEOUT_MS = 5000;
    const TOTAL_BUDGET_MS = 20000;
    const startedAt = Date.now();
    const rows = [];
    let error = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (Date.now() - startedAt > TOTAL_BUDGET_MS) {
        error = new Error(`Query budget exceeded after ${page} pages`);
        break;
      }
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const query = getClient()
        .from('events')
        .select('event, session_id, timestamp, properties')
        .gte('timestamp', since60dAgo)
        .order('timestamp', { ascending: true })
        .range(from, to);
      let res;
      try {
        res = await Promise.race([
          query,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Page ${page} timed out after ${PAGE_TIMEOUT_MS}ms`)), PAGE_TIMEOUT_MS)
          ),
        ]);
      } catch (e) {
        error = e;
        break;
      }
      if (res.error) { error = res.error; break; }
      if (!res.data || res.data.length === 0) break;
      rows.push(...res.data);
      if (res.data.length < PAGE_SIZE) break;
    }

    if (error) {
      console.error('Admin stats query error:', error);
      captureException(error, { scope: 'admin-stats.query' });
      return { statusCode: 500, body: 'DB error' };
    }

    // Window cutoffs: events with timestamp >= cutoff fall inside the window.
    // Named `since*` to make the direction obvious (e.g. since24hAgo is the
    // moment 24 hours before `now`, not a 24-hour bucket).
    const since24hAgo = new Date(now - 24 * 60 * 60 * 1000);
    const since7dAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const since30dAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

    // Compute period stats
    const periods = {};
    for (const [label, cutoff] of [['24h', since24hAgo], ['7d', since7dAgo], ['30d', since30dAgo]]) {
      const subset = rows.filter(r => new Date(r.timestamp) >= cutoff);
      const eventCounts = {};
      const sessions = new Set();
      for (const r of subset) {
        eventCounts[r.event] = (eventCounts[r.event] || 0) + 1;
        sessions.add(r.session_id);
      }
      periods[label] = {
        total_events: subset.length,
        unique_sessions: sessions.size,
        events: eventCounts,
      };
    }

    // Previous period stats for trend comparison
    const prev_periods = {};
    const prevWindows = [
      ['24h', new Date(now - 48 * 60 * 60 * 1000), since24hAgo],
      ['7d', new Date(now - 14 * 24 * 60 * 60 * 1000), since7dAgo],
      ['30d', new Date(now - 60 * 24 * 60 * 60 * 1000), since30dAgo],
    ];
    for (const [label, from, to] of prevWindows) {
      const subset = rows.filter(r => {
        const t = new Date(r.timestamp);
        return t >= from && t < to;
      });
      const sessions = new Set();
      for (const r of subset) sessions.add(r.session_id);
      prev_periods[label] = {
        total_events: subset.length,
        unique_sessions: sessions.size,
      };
    }

    // Funnel: count unique sessions that reached each step (30d only)
    const rows30 = rows.filter(r => new Date(r.timestamp) >= since30dAgo);
    const sessionEvents = {};
    for (const r of rows30) {
      if (!sessionEvents[r.session_id]) sessionEvents[r.session_id] = new Set();
      sessionEvents[r.session_id].add(r.event);
    }
    // Also include skip_clicked as an alternative to apply_clicked
    const funnel = {};
    for (const step of FUNNEL_ORDER) {
      let count = 0;
      for (const evts of Object.values(sessionEvents)) {
        if (step === 'apply_clicked') {
          if (evts.has('apply_clicked') || evts.has('skip_clicked')) count++;
        } else {
          if (evts.has(step)) count++;
        }
      }
      funnel[step] = count;
    }

    // Daily event counts (last 30 days)
    const dailyMap = {};
    for (const r of rows30) {
      const day = r.timestamp.slice(0, 10);
      if (!dailyMap[day]) dailyMap[day] = { events: 0, sessions: new Set() };
      dailyMap[day].events++;
      dailyMap[day].sessions.add(r.session_id);
    }
    const daily = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      daily.push({
        date: key,
        events: dailyMap[key]?.events || 0,
        sessions: dailyMap[key]?.sessions?.size || 0,
      });
    }

    // Feature usage aggregation (30d)
    const features = {
      device: { mobile: 0, desktop: 0 },
      export_format: {},
      export_action: {},
      blur_mode: {},
      comfyui: { completed: 0, failed: 0, errors: {} },
    };
    for (const r of rows30) {
      const props = r.properties || {};
      if (r.event === 'app_loaded' && props.device) {
        const d = props.device === 'mobile' ? 'mobile' : 'desktop';
        features.device[d]++;
      }
      if (r.event === 'export_completed') {
        if (props.format) {
          features.export_format[props.format] = (features.export_format[props.format] || 0) + 1;
        }
        if (props.action) {
          features.export_action[props.action] = (features.export_action[props.action] || 0) + 1;
        }
      }
      if (r.event === 'blur_mode_changed' && props.mode) {
        features.blur_mode[props.mode] = (features.blur_mode[props.mode] || 0) + 1;
      }
      if (r.event === 'comfyui_completed') {
        features.comfyui.completed++;
      }
      if (r.event === 'comfyui_failed') {
        features.comfyui.failed++;
        const msg = props.error || 'Unknown error';
        features.comfyui.errors[msg] = (features.comfyui.errors[msg] || 0) + 1;
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ periods, funnel, daily, features, prev_periods }),
    };
  } catch (err) {
    console.error('Admin stats error:', err);
    captureException(err, { scope: 'admin-stats.unhandled' });
    return { statusCode: 500, body: 'Server error' };
  }
}

export const handler = withSentry(adminStatsHandler);
