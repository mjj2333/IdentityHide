// Handler-level tests for the Stripe functions. The infrastructure edges
// (rate limit, origin check, Sentry, the real Stripe/Supabase clients) are
// replaced; everything else is the real handler code.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const NOW = Date.parse('2026-09-22T12:00:00Z');
const DAY = 86_400_000;
const secs = (ms) => Math.floor(ms / 1000);

let stripeFake;
let dbFake;

vi.mock('../rateLimit.js', () => ({
  rateLimit: async () => ({ limited: false }),
  checkOrigin: () => ({ rejected: false }),
}));
vi.mock('../_sentry.js', () => ({
  withSentry: (h) => h,
  captureException: () => {},
}));
vi.mock('../_clients.js', () => ({
  getStripe: () => stripeFake,
  getSupabase: () => dbFake,
}));

function makeStripe({ customers = [], subscriptions = [] } = {}) {
  const calls = { cancelled: [], checkoutCreate: [], portalCreate: [] };
  return {
    calls,
    customers: { list: async ({ email }) => ({ data: customers.filter((c) => c.email === email) }) },
    subscriptions: {
      list: async ({ customer }) => ({ data: subscriptions.filter((s) => s.customer === customer) }),
      cancel: async (id) => { calls.cancelled.push(id); return { id }; },
    },
    checkout: { sessions: { create: async (params) => { calls.checkoutCreate.push(params); return { url: 'https://checkout.stripe.test/s' }; } } },
    billingPortal: { sessions: { create: async (params) => { calls.portalCreate.push(params); return { url: 'https://billing.stripe.test/p' }; } } },
    prices: { retrieve: async (id) => ({ id, product: ['price_month', 'price_year'].includes(id) ? 'prod_ours' : 'prod_theirs' }) },
  };
}

function makeDb({ subscriptions = [], beta_redemptions = [], feedback = [] } = {}) {
  const tables = { subscriptions: new Map(subscriptions.map((r) => [r.email, { ...r }])), beta_redemptions: new Map(beta_redemptions.map((r) => [r.email, { ...r }])), feedback };
  const writes = [];
  const from = (name) => {
    const t = tables[name];
    const q = {
      _op: 'select', _payload: null, _email: null,
      select() { return q; },
      eq(col, val) { if (col === 'email' || col === 'contact') q._email = val; return q; },
      maybeSingle: async () => ({ data: (t instanceof Map ? t.get(q._email) : null) || null, error: null }),
      upsert(row) { q._op = 'upsert'; q._payload = row; return q; },
      update(patch) { q._op = 'update'; q._payload = patch; return q; },
      delete() { q._op = 'delete'; return q; },
      then(resolve) {
        if (t instanceof Map) {
          if (q._op === 'upsert') t.set(q._payload.email, { ...(t.get(q._payload.email) || {}), ...q._payload });
          if (q._op === 'update' && t.has(q._email)) t.set(q._email, { ...t.get(q._email), ...q._payload });
          if (q._op === 'delete') t.delete(q._email);
        }
        writes.push({ table: name, op: q._op, email: q._email || q._payload?.email });
        resolve({ data: null, error: null });
      },
    };
    return q;
  };
  return { tables, writes, from };
}

const live = (id, customer, created, periodEnd, status = 'active', product = 'prod_ours') => ({ id, customer, status, created: secs(created), cancel_at_period_end: false, items: { data: [{ current_period_end: secs(periodEnd), price: { id: product === 'prod_ours' ? 'price_month' : 'price_other', product } }] } });
const get = (qs) => ({ httpMethod: 'GET', headers: { origin: 'https://redactid.app' }, queryStringParameters: qs });
const post = (body) => ({ httpMethod: 'POST', headers: { origin: 'https://redactid.app' }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.STRIPE_PRICE_MONTHLY = 'price_month';
  process.env.STRIPE_PRICE_ANNUAL = 'price_year';
  stripeFake = makeStripe();
  dbFake = makeDb();
});

describe('entitlement', () => {
  it('grants premium from Stripe when the row is missing, and writes the row (the drice233 case)', async () => {
    stripeFake = makeStripe({ customers: [{ id: 'cus_1', email: 'a@b.c' }], subscriptions: [live('sub_1', 'cus_1', NOW - 30 * DAY, NOW + 28 * DAY)] });
    const { handler } = await import('../entitlement.js');
    const res = await handler(get({ email: 'a@b.c' }));
    expect(JSON.parse(res.body)).toEqual({ premium: true, expiresAt: NOW + 28 * DAY, source: 'stripe' });
    expect(dbFake.tables.subscriptions.get('a@b.c')).toMatchObject({ subscription_id: 'sub_1', status: 'active' });
  });

  it('re-points a row stuck on a cancelled subscription when Stripe has a live one (the foxdigital case)', async () => {
    dbFake = makeDb({ subscriptions: [{ email: 'a@b.c', customer_id: 'cus_dead', subscription_id: 'sub_dead', status: 'canceled', current_period_end: NOW - DAY }] });
    stripeFake = makeStripe({ customers: [{ id: 'cus_live', email: 'a@b.c' }], subscriptions: [live('sub_live', 'cus_live', NOW - 5 * DAY, NOW + 25 * DAY)] });
    const { handler } = await import('../entitlement.js');
    const res = await handler(get({ email: 'a@b.c' }));
    expect(JSON.parse(res.body).premium).toBe(true);
    expect(dbFake.tables.subscriptions.get('a@b.c').subscription_id).toBe('sub_live');
  });

  it('stays not-premium, with nothing written, when Stripe has nothing either', async () => {
    const { handler } = await import('../entitlement.js');
    const res = await handler(get({ email: 'nobody@b.c' }));
    expect(JSON.parse(res.body)).toEqual({ premium: false, expiresAt: null, source: null });
    expect(dbFake.writes).toEqual([]);
  });

  it('does not ask Stripe at all when the row already grants premium', async () => {
    dbFake = makeDb({ subscriptions: [{ email: 'a@b.c', customer_id: 'cus_1', subscription_id: 'sub_1', status: 'active', current_period_end: NOW + DAY }] });
    stripeFake.customers.list = async () => { throw new Error('should not be called'); };
    const { handler } = await import('../entitlement.js');
    const res = await handler(get({ email: 'a@b.c' }));
    expect(JSON.parse(res.body).premium).toBe(true);
  });

  it('still honours an admin beta grant with no Stripe subscription', async () => {
    dbFake = makeDb({ beta_redemptions: [{ email: 'a@b.c', expires_at: null }] });
    const { handler } = await import('../entitlement.js');
    const res = await handler(get({ email: 'a@b.c' }));
    expect(JSON.parse(res.body)).toEqual({ premium: true, expiresAt: null, source: 'beta' });
  });
});

describe('customer-portal', () => {
  it('opens the portal for the Stripe customer even when the row is missing', async () => {
    stripeFake = makeStripe({ customers: [{ id: 'cus_1', email: 'a@b.c' }], subscriptions: [live('sub_1', 'cus_1', NOW - DAY, NOW + 29 * DAY)] });
    const { handler } = await import('../customer-portal.js');
    const res = await handler(post({ email: 'a@b.c' }));
    expect(res.statusCode).toBe(200);
    expect(stripeFake.calls.portalCreate[0]).toMatchObject({ customer: 'cus_1', return_url: 'https://redactid.app/account' });
    expect(stripeFake.calls.portalCreate[0].flow_data).toBeUndefined();
  });

  it('deep-links straight into the cancel flow for the row\'s subscription when asked', async () => {
    dbFake = makeDb({ subscriptions: [{ email: 'a@b.c', customer_id: 'cus_1', subscription_id: 'sub_1', status: 'active', current_period_end: NOW + DAY }] });
    const { handler } = await import('../customer-portal.js');
    const res = await handler(post({ email: 'a@b.c', flow: 'cancel' }));
    expect(res.statusCode).toBe(200);
    expect(stripeFake.calls.portalCreate[0].flow_data).toEqual({ type: 'subscription_cancel', subscription_cancel: { subscription: 'sub_1' } });
  });

  it('is still 404 for an email with no subscription anywhere', async () => {
    const { handler } = await import('../customer-portal.js');
    const res = await handler(post({ email: 'nobody@b.c' }));
    expect(res.statusCode).toBe(404);
    expect(stripeFake.calls.portalCreate).toEqual([]);
  });
});

describe('delete-account', () => {
  it('cancels every running subscription Stripe has for the email, even with no row, then deletes the rows', async () => {
    stripeFake = makeStripe({
      customers: [{ id: 'cus_1', email: 'a@b.c' }, { id: 'cus_2', email: 'a@b.c' }],
      subscriptions: [live('sub_1', 'cus_1', NOW - 100 * DAY, NOW + 10 * DAY), live('sub_2', 'cus_2', NOW - DAY, NOW + 29 * DAY), live('sub_old', 'cus_1', NOW - 400 * DAY, NOW - 370 * DAY, 'canceled')],
    });
    dbFake = makeDb({ beta_redemptions: [{ email: 'a@b.c', expires_at: null }] });
    const { handler } = await import('../delete-account.js');
    const res = await handler(post({ email: 'a@b.c' }));
    expect(res.statusCode).toBe(200);
    expect(stripeFake.calls.cancelled.sort()).toEqual(['sub_1', 'sub_2']);
    expect(dbFake.tables.beta_redemptions.has('a@b.c')).toBe(false);
    expect(dbFake.writes.some((w) => w.table === 'subscriptions' && w.op === 'delete')).toBe(true);
  });

  it('cancels a trialing subscription too (the old code only cancelled status === active)', async () => {
    stripeFake = makeStripe({ customers: [{ id: 'cus_1', email: 'a@b.c' }], subscriptions: [live('sub_t', 'cus_1', NOW - DAY, NOW + 6 * DAY, 'trialing')] });
    const { handler } = await import('../delete-account.js');
    await handler(post({ email: 'a@b.c' }));
    expect(stripeFake.calls.cancelled).toEqual(['sub_t']);
  });

  it('reports partial failure instead of pretending everything was cancelled', async () => {
    stripeFake = makeStripe({ customers: [{ id: 'cus_1', email: 'a@b.c' }], subscriptions: [live('sub_1', 'cus_1', NOW - DAY, NOW + DAY)] });
    stripeFake.subscriptions.cancel = async () => { throw new Error('stripe down'); };
    const { handler } = await import('../delete-account.js');
    const res = await handler(post({ email: 'a@b.c' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, cancelled: [], failed: ['sub_1'] });
  });
});

describe('stripe-checkout', () => {
  it('refuses a second checkout for an email that already has a live subscription', async () => {
    stripeFake = makeStripe({ customers: [{ id: 'cus_1', email: 'a@b.c' }], subscriptions: [live('sub_1', 'cus_1', NOW - DAY, NOW + 29 * DAY)] });
    const { handler } = await import('../stripe-checkout.js');
    const res = await handler(post({ priceKey: 'monthly', email: 'a@b.c' }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'already_subscribed' });
    expect(stripeFake.calls.checkoutCreate).toEqual([]);
  });

  it('reuses the existing Stripe customer for a returning email with no live subscription', async () => {
    stripeFake = makeStripe({ customers: [{ id: 'cus_1', email: 'a@b.c' }], subscriptions: [live('sub_old', 'cus_1', NOW - 200 * DAY, NOW - 170 * DAY, 'canceled')] });
    const { handler } = await import('../stripe-checkout.js');
    const res = await handler(post({ priceKey: 'monthly', email: 'a@b.c' }));
    expect(res.statusCode).toBe(200);
    expect(stripeFake.calls.checkoutCreate[0]).toMatchObject({ customer: 'cus_1', mode: 'subscription' });
    expect(stripeFake.calls.checkoutCreate[0].customer_email).toBeUndefined();
  });

  it('prefills the email for a brand-new subscriber', async () => {
    const { handler } = await import('../stripe-checkout.js');
    const res = await handler(post({ priceKey: 'annual', email: 'new@b.c' }));
    expect(res.statusCode).toBe(200);
    expect(stripeFake.calls.checkoutCreate[0]).toMatchObject({ customer_email: 'new@b.c', line_items: [{ price: 'price_year', quantity: 1 }] });
    expect(stripeFake.calls.checkoutCreate[0].customer).toBeUndefined();
  });

  it('behaves exactly as before when no email is known (Stripe collects it)', async () => {
    stripeFake.customers.list = async () => { throw new Error('should not be called'); };
    const { handler } = await import('../stripe-checkout.js');
    const res = await handler(post({ priceKey: 'monthly' }));
    expect(res.statusCode).toBe(200);
    expect(stripeFake.calls.checkoutCreate[0].customer).toBeUndefined();
    expect(stripeFake.calls.checkoutCreate[0].customer_email).toBeUndefined();
  });

  it('still starts checkout if the Stripe lookup itself fails (a lookup outage must not block sales)', async () => {
    stripeFake.customers.list = async () => { throw new Error('stripe down'); };
    const { handler } = await import('../stripe-checkout.js');
    const res = await handler(post({ priceKey: 'monthly', email: 'a@b.c' }));
    expect(res.statusCode).toBe(200);
    expect(stripeFake.calls.checkoutCreate).toHaveLength(1);
  });
});

describe("the other app's subscription on the same email", () => {
  it('does not make the entitlement premium', async () => {
    stripeFake = makeStripe({ customers: [{ id: 'cus_1', email: 'a@b.c' }], subscriptions: [live('sub_theirs', 'cus_1', NOW - DAY, NOW + 29 * DAY, 'active', 'prod_theirs')] });
    const { handler } = await import('../entitlement.js');
    expect(JSON.parse((await handler(get({ email: 'a@b.c' }))).body).premium).toBe(false);
  });

  it('is not cancelled by delete-account', async () => {
    stripeFake = makeStripe({ customers: [{ id: 'cus_1', email: 'a@b.c' }], subscriptions: [live('sub_theirs', 'cus_1', NOW - DAY, NOW + 29 * DAY, 'active', 'prod_theirs'), live('sub_ours', 'cus_1', NOW - DAY, NOW + 29 * DAY)] });
    const { handler } = await import('../delete-account.js');
    await handler(post({ email: 'a@b.c' }));
    expect(stripeFake.calls.cancelled).toEqual(['sub_ours']);
  });

  it('does not block a checkout for this app', async () => {
    stripeFake = makeStripe({ customers: [{ id: 'cus_1', email: 'a@b.c' }], subscriptions: [live('sub_theirs', 'cus_1', NOW - DAY, NOW + 29 * DAY, 'active', 'prod_theirs')] });
    const { handler } = await import('../stripe-checkout.js');
    const res = await handler(post({ priceKey: 'monthly', email: 'a@b.c' }));
    expect(res.statusCode).toBe(200);
    expect(stripeFake.calls.checkoutCreate[0]).toMatchObject({ customer: 'cus_1' });   // still reuses the person's customer
  });
});
