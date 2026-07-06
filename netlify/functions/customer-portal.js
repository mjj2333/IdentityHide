// Creates a Stripe Billing Portal session for a known email. Client hits
// this from the AccountScreen "Manage subscription" button; we return a
// Stripe URL and the browser redirects there.
//
// Trust model: this endpoint creates a portal session for any email it
// finds in the subscriptions table. Matches the client-trusted paywall
// design — a user who knows someone else's email can open that person's
// portal. Acceptable for MVP; revisit if fraud becomes a concern.
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { rateLimit, checkOrigin } from './rateLimit.js';
import { withSentry, captureException } from './_sentry.js';
import { withCors } from './_cors.js';

let supabase;
function getSupabase() {
  if (!supabase) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabase;
}

function emailKey(email) {
  return String(email || '').trim().toLowerCase();
}

async function customerPortalHandler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: {} };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const origin = checkOrigin(event);
  if (origin.rejected) return origin.response;

  const rl = await rateLimit(event, 10);
  if (rl.limited) return rl.response;

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return { statusCode: 500, body: 'Not configured' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }
  const email = emailKey(body.email);
  if (!email || email.length > 254) {
    return { statusCode: 400, body: 'Invalid email' };
  }

  let row;
  try {
    const { data, error } = await getSupabase()
      .from('subscriptions')
      .select('customer_id')
      .eq('email', email)
      .maybeSingle();
    if (error) throw error;
    row = data;
  } catch (err) {
    console.error('[customer-portal] db read failed:', err.message);
    return { statusCode: 500, body: 'Could not look up account' };
  }
  if (!row?.customer_id) {
    return { statusCode: 404, body: 'No subscription found for this email' };
  }

  const reqOrigin = event.headers['origin'] || event.headers['referer']?.replace(/\/$/, '') || '';
  try {
    const stripe = new Stripe(secret);
    const session = await stripe.billingPortal.sessions.create({
      customer: row.customer_id,
      return_url: `${reqOrigin}/account`,
    });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    captureException(err, { context: 'customer-portal.create' });
    console.error('[customer-portal] create session failed:', err.message);
    return { statusCode: 500, body: 'Could not open portal' };
  }
}

export const handler = withCors(withSentry(customerPortalHandler));
