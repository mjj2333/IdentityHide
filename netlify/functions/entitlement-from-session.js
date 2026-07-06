// Called on the /success?session_id=... landing after Stripe Checkout.
// Looks up the Checkout Session by ID (server-to-Stripe, trusted), extracts
// the email, and returns whether they're now premium + the email (so the
// client can persist it to localStorage as `ih_user_email`).
//
// This is the ONLY way the client learns the email after a successful
// checkout without relying on client-side form state (Checkout is hosted,
// our JS never sees the email the user typed).
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

async function entitlementFromSessionHandler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: {} };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const origin = checkOrigin(event);
  if (origin.rejected) return origin.response;

  const rl = await rateLimit(event, 20);
  if (rl.limited) return rl.response;

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return { statusCode: 500, body: 'Not configured' };
  }

  const sessionId = event.queryStringParameters?.session_id;
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 200) {
    return { statusCode: 400, body: 'Invalid session_id' };
  }
  // Stripe session IDs look like `cs_test_...` or `cs_live_...`. Strict prefix
  // check rejects casual probing.
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    return { statusCode: 400, body: 'Invalid session_id' };
  }

  const stripe = new Stripe(secret);
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (err) {
    captureException(err, { context: 'entitlement-from-session.retrieve' });
    return { statusCode: 404, body: 'Session not found' };
  }

  const email = (session.customer_details?.email || session.customer_email || '').trim().toLowerCase();
  if (!email) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: null, premium: false, expiresAt: null }),
    };
  }

  // Read the DB row the webhook should have written. The webhook is usually
  // faster than the user's redirect, but not guaranteed — if the row isn't
  // there yet, return premium=true optimistically based on the session's
  // payment_status. The next entitlement check will reconcile.
  let row = null;
  try {
    const { data, error } = await getSupabase()
      .from('subscriptions')
      .select('status, current_period_end')
      .eq('email', email)
      .maybeSingle();
    if (error) throw error;
    row = data;
  } catch (err) {
    console.error('[entitlement-from-session] db read failed:', err.message);
  }

  const now = Date.now();
  let premium = false;
  let expiresAt = null;
  if (row) {
    expiresAt = row.current_period_end || null;
    premium = (row.status === 'active' || row.status === 'trialing' || row.status === 'canceled')
      && expiresAt && expiresAt > now;
  } else if (session.payment_status === 'paid' || session.status === 'complete') {
    // Optimistic: we trust the session. Webhook will fill the DB shortly.
    premium = true;
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, premium: !!premium, expiresAt }),
  };
}

export const handler = withCors(withSentry(entitlementFromSessionHandler));
