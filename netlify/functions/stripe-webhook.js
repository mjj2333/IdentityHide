// Stripe webhook receiver. Verifies signature with STRIPE_WEBHOOK_SECRET and
// upserts subscription state into the Supabase `subscriptions` table keyed by
// lowercased email. No rate limiting — Stripe retries are idempotent and we
// want to accept every legitimate event.
//
// Only this app's subscriptions (matched by product, see _subscriptionSync)
// are handled: the Stripe account is shared with another app, whose events
// arrive here too and used to overwrite this app's rows.
//
// Relevant events:
// - checkout.session.completed: first subscription signup, creates/updates row
// - customer.subscription.updated: plan change / renewal / payment_status flip
// - customer.subscription.deleted: cancellation took effect, mark canceled
import { getStripe, getSupabase } from './_clients.js';
import { isOwnSubscription, reconcileFromStripe } from './_subscriptionSync.js';
import { withSentry, captureException } from './_sentry.js';

function emailKey(email) {
  return String(email || '').trim().toLowerCase();
}

// Stripe moved `current_period_end` off Subscription onto each SubscriptionItem
// in the 2024-12-18 API version. We handle both shapes so the same code works
// regardless of which API version the webhook arrives on. Returns milliseconds
// (Stripe gives unix seconds), or null if neither location has it.
function resolveCurrentPeriodEnd(subscription) {
  const fromItem = subscription?.items?.data?.[0]?.current_period_end;
  const fromSub = subscription?.current_period_end;
  const seconds = fromItem ?? fromSub ?? null;
  return seconds ? seconds * 1000 : null;
}

async function upsert(email, updates) {
  const key = emailKey(email);
  if (!key) return;
  const row = {
    email: key,
    ...updates,
    updated_at: new Date().toISOString(),
  };
  const { error } = await getSupabase()
    .from('subscriptions')
    .upsert(row, { onConflict: 'email' });
  if (error) throw error;
}

async function handleCheckoutCompleted(stripe, session) {
  const email = session.customer_details?.email || session.customer_email;
  if (!email) {
    console.warn('[stripe-webhook] checkout.session.completed with no email', session.id);
    return;
  }
  let subscription = null;
  if (session.subscription) {
    try {
      subscription = await stripe.subscriptions.retrieve(session.subscription);
    } catch (err) {
      captureException(err, { context: 'webhook.retrieve-subscription', sessionId: session.id });
    }
  }
  if (subscription && !(await isOwnSubscription(stripe, subscription))) return;   // the other app's sale
  await upsert(email, {
    customer_id: session.customer,
    subscription_id: session.subscription || null,
    status: subscription?.status || 'active',
    current_period_end: resolveCurrentPeriodEnd(subscription),
  });
}

// True when the row for this email is about this very subscription (or has
// no subscription recorded / no row - nothing to protect).
async function rowIsAbout(email, subscription) {
  const { data, error } = await getSupabase()
    .from('subscriptions')
    .select('subscription_id')
    .eq('email', emailKey(email))
    .maybeSingle();
  if (error) throw error;
  return !data?.subscription_id || data.subscription_id === subscription.id;
}

async function handleSubscriptionUpdated(stripe, subscription) {
  let email = null;
  try {
    const customer = await stripe.customers.retrieve(subscription.customer);
    email = customer?.email;
  } catch (err) {
    captureException(err, { context: 'webhook.retrieve-customer', customerId: subscription.customer });
  }
  if (!email) {
    console.warn('[stripe-webhook] subscription.updated with no customer email', subscription.id);
    return;
  }
  if (!(await isOwnSubscription(stripe, subscription))) return;
  if (!(await rowIsAbout(email, subscription))) {
    // An event about ANOTHER of this app's subscriptions for the same email
    // (a duplicate purchase being cancelled, say). Don't smear its status
    // over the row; let Stripe say which subscription should hold it.
    await reconcileFromStripe({ stripe, supabase: getSupabase(), email });
    return;
  }
  // UPDATE-only (not upsert). Same rationale as handleSubscriptionDeleted:
  // when a user runs /delete-account, Stripe fires subscription.updated
  // (status=canceled) BEFORE subscription.deleted. If we upsert here we
  // resurrect the row we just removed. Initial subscription creation goes
  // through handleCheckoutCompleted, which IS an upsert — so a missing row
  // at update time means either (a) the user just deleted their account,
  // or (b) we missed the checkout webhook (already-broken state, not worth
  // healing here at the cost of breaking deletion).
  const key = emailKey(email);
  if (!key) return;
  const { error } = await getSupabase()
    .from('subscriptions')
    .update({
      customer_id: subscription.customer,
      subscription_id: subscription.id,
      status: subscription.status,
      current_period_end: resolveCurrentPeriodEnd(subscription),
      updated_at: new Date().toISOString(),
    })
    .eq('email', key);
  if (error) throw error;
}

async function handleSubscriptionDeleted(stripe, subscription) {
  let email = null;
  try {
    const customer = await stripe.customers.retrieve(subscription.customer);
    email = customer?.email;
  } catch (err) {
    captureException(err, { context: 'webhook.retrieve-customer', customerId: subscription.customer });
  }
  if (!email) return;
  if (!(await isOwnSubscription(stripe, subscription))) return;
  if (!(await rowIsAbout(email, subscription))) {
    await reconcileFromStripe({ stripe, supabase: getSupabase(), email });
    return;
  }
  // UPDATE-only (not upsert). Two reasons:
  //   1. If the user has just deleted their account via /delete-account, the
  //      subscriptions row is already gone. Upserting here would resurrect
  //      it as a "ghost" row with status='canceled' — same email, same data,
  //      defeating the deletion. Update-only makes this webhook a no-op
  //      against a deleted row.
  //   2. A subscription.deleted event for an email we never had in our DB
  //      means our state is already correct (no premium for that email).
  //      Creating a tombstone row is just noise.
  const key = emailKey(email);
  if (!key) return;
  const { error } = await getSupabase()
    .from('subscriptions')
    .update({
      status: 'canceled',
      current_period_end: resolveCurrentPeriodEnd(subscription),
      updated_at: new Date().toISOString(),
    })
    .eq('email', key);
  if (error) throw error;
}

async function stripeWebhookHandler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  const secret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !webhookSecret) {
    console.error('[stripe-webhook] secrets not configured');
    return { statusCode: 500, body: 'Webhook unavailable' };
  }

  // Stripe requires the raw body for signature verification.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  const sig = event.headers['stripe-signature'];
  if (!sig) {
    return { statusCode: 400, body: 'Missing signature' };
  }

  const stripe = getStripe();
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.warn('[stripe-webhook] signature verification failed:', err.message);
    return { statusCode: 400, body: 'Invalid signature' };
  }

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(stripe, stripeEvent.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(stripe, stripeEvent.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(stripe, stripeEvent.data.object);
        break;
      default:
        break;
    }
    return { statusCode: 200, body: '{"received":true}' };
  } catch (err) {
    captureException(err, { context: 'stripe-webhook.handle', eventType: stripeEvent.type });
    console.error('[stripe-webhook] handler failed:', err.message);
    // Return 500 so Stripe retries — the event will be re-delivered, giving
    // us another chance to persist the state.
    return { statusCode: 500, body: 'Webhook handler failed' };
  }
}

export const handler = withSentry(stripeWebhookHandler);
