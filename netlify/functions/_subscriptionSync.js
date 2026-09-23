// Stripe is the source of truth for subscriptions; the Supabase
// `subscriptions` row is a cache of it, keyed by email. Until 2026-09-22 that
// cache was written ONLY by the checkout webhook and could never be rebuilt:
// a missing row (the webhook wasn't there yet, or Delete account removed it)
// or a row left pointing at a dead subscription (two checkouts for one email,
// each on its OWN Stripe customer — the row keeps whichever finished last)
// meant "Inactive" in the app while Stripe kept billing. These helpers let
// the functions ask Stripe directly and repair the row.
//
// The Stripe account is SHARED with another app (Companion), and a person can
// subscribe to both with one email. Every helper therefore takes the price ids
// this app sells (`priceIds`, from env) and looks only at subscriptions whose
// PRODUCT matches - product rather than price so an older price of the same
// plan still counts. Without a price list nothing is listed (fail closed):
// better to show a paywall than to cancel someone's other-app subscription.
//
// Every function takes the Stripe and Supabase clients as arguments so the
// logic is unit-testable with fakes.

const ENTITLING = new Set(['active', 'trialing']);
// Statuses Stripe will still bill or retry for. `canceled` and `incomplete_expired`
// are already over; anything else is cancelled on account deletion.
const RUNNING = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']);

function emailKey(email) {
  return String(email || '').trim().toLowerCase();
}

/** The price ids this deployment sells, from env. */
export function ownPriceIds() {
  return [process.env.STRIPE_PRICE_MONTHLY, process.env.STRIPE_PRICE_ANNUAL].filter(Boolean);
}

// price id -> product id, looked up once per function instance.
const productCache = new Map();
async function ownProductIds(stripe, priceIds) {
  const out = new Set();
  for (const id of priceIds || []) {
    if (!productCache.has(id)) {
      const price = await stripe.prices.retrieve(id);
      productCache.set(id, typeof price.product === 'string' ? price.product : price.product?.id);
    }
    if (productCache.get(id)) out.add(productCache.get(id));
  }
  return out;
}

function subscriptionProduct(subscription) {
  const price = subscription?.items?.data?.[0]?.price;
  return typeof price?.product === 'string' ? price.product : price?.product?.id || null;
}

/** Whether a raw Stripe subscription belongs to this app. */
export async function isOwnSubscription(stripe, subscription, priceIds = ownPriceIds()) {
  const products = await ownProductIds(stripe, priceIds);
  return products.has(subscriptionProduct(subscription));
}

// Stripe moved current_period_end from the Subscription onto each item in the
// 2024-12-18 API version; accept either shape. Stripe gives unix seconds.
function periodEndMs(subscription) {
  const seconds = subscription?.items?.data?.[0]?.current_period_end ?? subscription?.current_period_end ?? null;
  return seconds ? seconds * 1000 : null;
}

/**
 * Every subscription Stripe holds for an email, across every Customer that
 * carries it (Checkout creates a new Customer per purchase), oldest first.
 * Normalised to what the rest of the code needs.
 */
export async function listStripeSubscriptions(stripe, email, priceIds) {
  const key = emailKey(email);
  if (!key) return [];
  const products = await ownProductIds(stripe, priceIds);
  if (products.size === 0) return [];
  const customers = await stripe.customers.list({ email: key, limit: 100 });
  const out = [];
  for (const customer of customers.data || []) {
    const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 100 });
    for (const s of subs.data || []) {
      if (!products.has(subscriptionProduct(s))) continue;
      out.push({
        id: s.id,
        customer: customer.id,
        status: s.status,
        created: (s.created || 0) * 1000,
        currentPeriodEnd: periodEndMs(s),
        cancelAtPeriodEnd: !!s.cancel_at_period_end,
      });
    }
  }
  return out.sort((a, b) => a.created - b.created);
}

/**
 * The one subscription that should grant premium right now, or null.
 * Live (active/trialing, period not over) beats cancelled-but-paid-up;
 * within a tier the newest wins, so after a duplicate checkout the row
 * follows the purchase the person just made.
 */
export function pickEntitlingSubscription(subs, now = Date.now()) {
  const paidUp = (s) => !!s.currentPeriodEnd && s.currentPeriodEnd > now;
  const newest = (list) => list.slice().sort((a, b) => b.created - a.created)[0] || null;
  const live = subs.filter((s) => ENTITLING.has(s.status) && paidUp(s));
  if (live.length) return newest(live);
  const cancelledButPaid = subs.filter((s) => s.status === 'canceled' && paidUp(s));
  return newest(cancelledButPaid);
}

/** The `subscriptions` row for one normalised Stripe subscription. */
export function rowFromSubscription(email, sub, now = Date.now()) {
  return {
    email: emailKey(email),
    customer_id: sub.customer,
    subscription_id: sub.id,
    status: sub.status,
    current_period_end: sub.currentPeriodEnd,
    updated_at: new Date(now).toISOString(),
  };
}

/**
 * Make the `subscriptions` row match Stripe for one email. Returns the row
 * that now grants access, or null when Stripe has nothing entitling — in
 * which case nothing is written (this never invents access, and never
 * downgrades a row on its own: the webhooks own that path). Any Stripe or
 * DB failure also returns null; callers fall back to whatever they had.
 */
export async function reconcileFromStripe({ stripe, supabase, email, now = Date.now(), priceIds = ownPriceIds() }) {
  const key = emailKey(email);
  if (!key) return null;
  try {
    const pick = pickEntitlingSubscription(await listStripeSubscriptions(stripe, key, priceIds), now);
    if (!pick) return null;
    const row = rowFromSubscription(key, pick, now);

    const { data: existing, error: readError } = await supabase
      .from('subscriptions')
      .select('customer_id, subscription_id, status, current_period_end')
      .eq('email', key)
      .maybeSingle();
    if (readError) throw readError;
    const same = existing
      && existing.customer_id === row.customer_id
      && existing.subscription_id === row.subscription_id
      && existing.status === row.status
      && existing.current_period_end === row.current_period_end;
    if (same) return { ...existing, email: key };

    const { error } = await supabase.from('subscriptions').upsert(row, { onConflict: 'email' });
    if (error) throw error;
    return row;
  } catch (err) {
    console.error('[subscriptionSync] reconcile failed:', err.message);
    return null;
  }
}

/**
 * Cancel, immediately, every subscription for the email that Stripe is still
 * running — across all its Customers, not just the one the row knows about.
 * Best effort per subscription; the caller decides what a failure means.
 */
export async function cancelAllSubscriptions(stripe, email, priceIds = ownPriceIds()) {
  const cancelled = [];
  const failed = [];
  const subs = await listStripeSubscriptions(stripe, email, priceIds);
  for (const s of subs) {
    if (!RUNNING.has(s.status)) continue;
    try {
      await stripe.subscriptions.cancel(s.id);
      cancelled.push(s.id);
    } catch (err) {
      failed.push({ id: s.id, error: err.message });
    }
  }
  return { cancelled, failed };
}
