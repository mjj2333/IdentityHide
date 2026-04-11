import { createClient } from '@supabase/supabase-js';
import { rateLimit, checkOrigin } from './rateLimit.js';
import { checkAdminAuth } from './auth.js';
import { withSentry, captureException } from './_sentry.js';

let supabase;
function getClient() {
  if (!supabase) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabase;
}

// Input caps. Each bound matches its Supabase column width so we reject at
// the edge instead of silently truncating — clients get 413 if they exceed
// any cap, which makes oversized-payload bugs loud instead of invisible.
const MAX_SUMMARY_LEN = 200;
const MAX_DETAILS_LEN = 3000;
const MAX_STEPS_LEN = 2000;
const MAX_CONTACT_LEN = 200;
const MAX_DEVICE_INFO_LEN = 500;
const MIN_SUMMARY_LEN = 3;
const MIN_DETAILS_LEN = 10;
// Admin list pagination — page size, not a validation bound.
const ADMIN_LIST_PAGE_SIZE = 200;

async function feedbackHandler(event) {
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

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  try {
    // Admin: delete feedback
    if (body.action === 'delete') {
      if (!checkAdminAuth(event)) {
        return { statusCode: 401, body: 'Unauthorized' };
      }
      // Feedback ids are bigints in Supabase — accept only a positive integer
      // or a numeric string that parses cleanly, to prevent unexpected matches
      // from arrays/objects/floats.
      const rawId = body.id;
      const idNum = typeof rawId === 'number' ? rawId : (typeof rawId === 'string' ? Number(rawId) : NaN);
      if (!Number.isInteger(idNum) || idNum <= 0) {
        return { statusCode: 400, body: 'Invalid feedback id' };
      }
      const { error } = await getClient()
        .from('feedback')
        .delete()
        .eq('id', idNum);

      if (error) {
        console.error('Feedback delete error:', error);
        captureException(error, { scope: 'feedback.delete' });
        return { statusCode: 500, body: 'DB error' };
      }
      return { statusCode: 200, body: 'Deleted' };
    }

    // Admin: list feedback
    if (body.action === 'list') {
      if (!checkAdminAuth(event)) {
        return { statusCode: 401, body: 'Unauthorized' };
      }
      const { data, error } = await getClient()
        .from('feedback')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(ADMIN_LIST_PAGE_SIZE);

      if (error) {
        console.error('Feedback list error:', error);
        captureException(error, { scope: 'feedback.list' });
        return { statusCode: 500, body: 'DB error' };
      }
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      };
    }

    // Public: submit feedback
    const { category, summary, details, steps, severity, contact, device_info } = body;

    if (!category || !['bug', 'ux', 'feature', 'general'].includes(category)) {
      return { statusCode: 400, body: 'Invalid category' };
    }
    if (!summary || typeof summary !== 'string' || summary.length < MIN_SUMMARY_LEN) {
      return { statusCode: 400, body: 'Summary required' };
    }
    if (summary.length > MAX_SUMMARY_LEN) {
      return { statusCode: 413, body: `Summary too long (max ${MAX_SUMMARY_LEN} chars)` };
    }
    if (!details || typeof details !== 'string' || details.length < MIN_DETAILS_LEN) {
      return { statusCode: 400, body: 'Details required' };
    }
    if (details.length > MAX_DETAILS_LEN) {
      return { statusCode: 413, body: `Details too long (max ${MAX_DETAILS_LEN} chars)` };
    }
    if (steps && (typeof steps !== 'string' || steps.length > MAX_STEPS_LEN)) {
      return { statusCode: 413, body: `Steps too long (max ${MAX_STEPS_LEN} chars)` };
    }
    if (contact && (typeof contact !== 'string' || contact.length > MAX_CONTACT_LEN)) {
      return { statusCode: 413, body: `Contact too long (max ${MAX_CONTACT_LEN} chars)` };
    }
    if (device_info && (typeof device_info !== 'string' || device_info.length > MAX_DEVICE_INFO_LEN)) {
      return { statusCode: 413, body: `device_info too long (max ${MAX_DEVICE_INFO_LEN} chars)` };
    }

    const { error } = await getClient().from('feedback').insert({
      category,
      summary,
      details,
      steps: steps || null,
      severity: severity && ['low', 'medium', 'high'].includes(severity) ? severity : null,
      contact: contact || null,
      device_info: device_info || null,
      user_agent: event.headers['user-agent'] || null,
    });

    if (error) {
      console.error('Feedback insert error:', error);
      captureException(error, { scope: 'feedback.insert' });
      return { statusCode: 500, body: 'DB error' };
    }

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error('Feedback error:', err);
    captureException(err, { scope: 'feedback.unhandled' });
    return { statusCode: 500, body: 'Server error' };
  }
}

export const handler = withSentry(feedbackHandler);
