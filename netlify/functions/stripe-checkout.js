// Creates a Stripe Checkout Session (subscription mode) and returns the URL
// for the client to redirect to. The client reads the body as JSON with
// { priceKey: 'monthly' | 'annual' } and then navigates to the returned url.
import Stripe from 'stripe';
import { rateLimit, checkOrigin } from './rateLimit.js';
import { withSentry, captureException } from './_sentry.js';
import { withCors } from './_cors.js';

const PRICE_KEYS = {
  monthly: 'STRIPE_PRICE_MONTHLY',
  annual: 'STRIPE_PRICE_ANNUAL',
};

async function stripeCheckoutHandler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: {} };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const origin = checkOrigin(event);
  if (origin.rejected) return origin.response;

  const rl = await rateLimit(event, 20);
  if (rl.limited) return rl.response;

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    console.error('[stripe-checkout] STRIPE_SECRET_KEY not configured');
    return { statusCode: 500, body: 'Checkout unavailable' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const priceKey = body.priceKey;
  const envVar = PRICE_KEYS[priceKey];
  if (!envVar) {
    return { statusCode: 400, body: 'Invalid priceKey' };
  }
  const priceId = process.env[envVar];
  if (!priceId) {
    console.error(`[stripe-checkout] ${envVar} not configured`);
    return { statusCode: 500, body: 'Checkout unavailable' };
  }

  // Build URLs from the request's origin so the same function works on draft
  // deploys, localhost, and prod without hardcoding the site URL.
  const reqOrigin = event.headers['origin'] || event.headers['referer']?.replace(/\/$/, '') || '';
  const successUrl = `${reqOrigin}/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${reqOrigin}/`;

  try {
    const stripe = new Stripe(secret);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      // Stripe Checkout collects email natively for subscription mode and
      // uses it as the Customer email. We don't need to pass it ourselves.
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
    });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    captureException(err, { context: 'stripe-checkout.create' });
    console.error('[stripe-checkout] create session failed:', err.message);
    return { statusCode: 500, body: 'Could not start checkout' };
  }
}

export const handler = withCors(withSentry(stripeCheckoutHandler));
