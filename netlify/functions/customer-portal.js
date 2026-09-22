// Creates a Stripe Billing Portal session for a known email. Client hits
// this from the AccountScreen "Manage subscription" button; we return a
// Stripe URL and the browser redirects there. With `flow: 'cancel'` the
// session opens straight on Stripe's cancel confirmation for the row's
// subscription (the portal allows cancellation, but hides the link under
// the plan's details where people don't find it).
//
// Trust model: this endpoint creates a portal session for any email it
// finds in the subscriptions table. Matches the client-trusted paywall
// design — a user who knows someone else's email can open that person's
// portal. Acceptable for MVP; revisit if fraud becomes a concern.
import { getStripe, getSupabase } from './_clients.js';
import { reconcileFromStripe } from './_subscriptionSync.js';
import { rateLimit, checkOrigin } from './rateLimit.js';
import { withSentry, captureException } from './_sentry.js';
import { withCors } from './_cors.js';

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
      .select('customer_id, subscription_id')
      .eq('email', email)
      .maybeSingle();
    if (error) throw error;
    row = data;
  } catch (err) {
    console.error('[customer-portal] db read failed:', err.message);
    return { statusCode: 500, body: 'Could not look up account' };
  }
  // No row (or a row with no customer)? The row is only a cache — check
  // Stripe before turning a paying customer away.
  if (!row?.customer_id) {
    row = await reconcileFromStripe({ stripe: getStripe(), supabase: getSupabase(), email });
  }
  if (!row?.customer_id) {
    return { statusCode: 404, body: 'No subscription found for this email' };
  }

  const reqOrigin = event.headers['origin'] || event.headers['referer']?.replace(/\/$/, '') || '';
  const params = {
    customer: row.customer_id,
    return_url: `${reqOrigin}/account`,
  };
  if (body.flow === 'cancel' && row.subscription_id) {
    params.flow_data = { type: 'subscription_cancel', subscription_cancel: { subscription: row.subscription_id } };
  }
  try {
    const session = await getStripe().billingPortal.sessions.create(params);
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
