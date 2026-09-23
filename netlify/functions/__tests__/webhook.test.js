// The webhook receives EVERY event on the shared Stripe account, including the
// other app's and those for other subscriptions of the same email. It must only
// write what is about this app, and only clobber the row for the subscription
// the row points at.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const NOW = Date.parse('2026-09-22T12:00:00Z');
const DAY = 86_400_000;
const secs = (ms) => Math.floor(ms / 1000);

let stripeFake;
let dbFake;
vi.mock('../_sentry.js', () => ({ withSentry: (h) => h, captureException: () => {} }));
vi.mock('../_clients.js', () => ({ getStripe: () => stripeFake, getSupabase: () => dbFake }));

const OURS = 'prod_ours', THEIRS = 'prod_theirs';
const sub = (id, customer, status, periodEnd, product = OURS, created = NOW - DAY) => ({
  id, customer, status, created: secs(created), cancel_at_period_end: false,
  items: { data: [{ current_period_end: secs(periodEnd), price: { id: product === OURS ? 'price_month' : 'price_other', product } }] },
});

function makeStripe({ customers = [], subscriptions = [] }) {
  return {
    webhooks: { constructEvent: (raw) => JSON.parse(raw) },
    prices: { retrieve: async (id) => ({ id, product: ['price_month', 'price_year'].includes(id) ? OURS : THEIRS }) },
    customers: {
      retrieve: async (id) => customers.find((c) => c.id === id),
      list: async ({ email }) => ({ data: customers.filter((c) => c.email === email) }),
    },
    subscriptions: {
      retrieve: async (id) => subscriptions.find((s) => s.id === id),
      list: async ({ customer }) => ({ data: subscriptions.filter((s) => s.customer === customer) }),
    },
  };
}

function makeDb(rows = []) {
  const table = new Map(rows.map((r) => [r.email, { ...r }]));
  const writes = [];
  const from = () => {
    const q = {
      _op: 'select', _payload: null, _email: null,
      select() { return q; },
      eq(col, val) { if (col === 'email') q._email = val; return q; },
      maybeSingle: async () => ({ data: table.get(q._email) || null, error: null }),
      upsert(row) { q._op = 'upsert'; q._payload = row; return q; },
      update(patch) { q._op = 'update'; q._payload = patch; return q; },
      then(resolve) {
        if (q._op === 'upsert') table.set(q._payload.email, { ...(table.get(q._payload.email) || {}), ...q._payload });
        if (q._op === 'update' && table.has(q._email)) table.set(q._email, { ...table.get(q._email), ...q._payload });
        writes.push(q._op);
        resolve({ data: null, error: null });
      },
    };
    return q;
  };
  return { table, writes, from };
}

const event = (type, object) => ({ httpMethod: 'POST', headers: { 'stripe-signature': 'sig' }, body: JSON.stringify({ type, data: { object } }) });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
  process.env.STRIPE_PRICE_MONTHLY = 'price_month';
  process.env.STRIPE_PRICE_ANNUAL = 'price_year';
});

describe('stripe-webhook', () => {
  it("ignores the other app's checkout instead of granting this app's premium", async () => {
    stripeFake = makeStripe({ customers: [{ id: 'cus_1', email: 'a@b.c' }], subscriptions: [sub('sub_theirs', 'cus_1', 'active', NOW + 29 * DAY, THEIRS)] });
    dbFake = makeDb();
    const { handler } = await import('../stripe-webhook.js');
    const res = await handler(event('checkout.session.completed', { id: 'cs_1', customer: 'cus_1', subscription: 'sub_theirs', customer_details: { email: 'a@b.c' } }));
    expect(res.statusCode).toBe(200);
    expect(dbFake.table.has('a@b.c')).toBe(false);
  });

  it("still records this app's checkout", async () => {
    stripeFake = makeStripe({ customers: [{ id: 'cus_1', email: 'a@b.c' }], subscriptions: [sub('sub_ours', 'cus_1', 'active', NOW + 29 * DAY)] });
    dbFake = makeDb();
    const { handler } = await import('../stripe-webhook.js');
    await handler(event('checkout.session.completed', { id: 'cs_1', customer: 'cus_1', subscription: 'sub_ours', customer_details: { email: 'a@b.c' } }));
    expect(dbFake.table.get('a@b.c')).toMatchObject({ subscription_id: 'sub_ours', status: 'active', current_period_end: NOW + 29 * DAY });
  });

  it("leaves the row alone when the other app's subscription for the same email renews or is cancelled", async () => {
    stripeFake = makeStripe({ customers: [{ id: 'cus_1', email: 'a@b.c' }], subscriptions: [] });
    dbFake = makeDb([{ email: 'a@b.c', customer_id: 'cus_ours', subscription_id: 'sub_ours', status: 'active', current_period_end: NOW + 20 * DAY }]);
    const { handler } = await import('../stripe-webhook.js');
    await handler(event('customer.subscription.updated', sub('sub_theirs', 'cus_1', 'active', NOW + 29 * DAY, THEIRS)));
    await handler(event('customer.subscription.deleted', sub('sub_theirs', 'cus_1', 'canceled', NOW + 29 * DAY, THEIRS)));
    expect(dbFake.table.get('a@b.c')).toMatchObject({ subscription_id: 'sub_ours', status: 'active', current_period_end: NOW + 20 * DAY });
    expect(dbFake.writes).toEqual([]);
  });

  it('cancelling a duplicate does not mark the row cancelled; the row follows the surviving subscription (the drice233 case)', async () => {
    stripeFake = makeStripe({
      customers: [{ id: 'cus_orig', email: 'a@b.c' }, { id: 'cus_dup', email: 'a@b.c' }],
      subscriptions: [sub('sub_orig', 'cus_orig', 'active', NOW + 20 * DAY, OURS, NOW - 150 * DAY), sub('sub_dup', 'cus_dup', 'canceled', NOW + 29 * DAY)],
    });
    dbFake = makeDb([{ email: 'a@b.c', customer_id: 'cus_orig', subscription_id: 'sub_orig', status: 'active', current_period_end: NOW + 20 * DAY }]);
    const { handler } = await import('../stripe-webhook.js');
    await handler(event('customer.subscription.deleted', sub('sub_dup', 'cus_dup', 'canceled', NOW + 29 * DAY)));
    expect(dbFake.table.get('a@b.c')).toMatchObject({ subscription_id: 'sub_orig', status: 'active', current_period_end: NOW + 20 * DAY });
  });

  it("cancelling the row's OWN subscription still marks it cancelled", async () => {
    stripeFake = makeStripe({ customers: [{ id: 'cus_1', email: 'a@b.c' }], subscriptions: [] });
    dbFake = makeDb([{ email: 'a@b.c', customer_id: 'cus_1', subscription_id: 'sub_ours', status: 'active', current_period_end: NOW + 20 * DAY }]);
    const { handler } = await import('../stripe-webhook.js');
    await handler(event('customer.subscription.deleted', sub('sub_ours', 'cus_1', 'canceled', NOW + 20 * DAY)));
    expect(dbFake.table.get('a@b.c')).toMatchObject({ subscription_id: 'sub_ours', status: 'canceled' });
  });

  it('when the row points at a dead subscription and another live one exists, an update event re-points it', async () => {
    stripeFake = makeStripe({
      customers: [{ id: 'cus_dead', email: 'a@b.c' }, { id: 'cus_live', email: 'a@b.c' }],
      subscriptions: [sub('sub_dead', 'cus_dead', 'canceled', NOW - DAY), sub('sub_live', 'cus_live', 'active', NOW + 29 * DAY)],
    });
    dbFake = makeDb([{ email: 'a@b.c', customer_id: 'cus_dead', subscription_id: 'sub_dead', status: 'canceled', current_period_end: NOW - DAY }]);
    const { handler } = await import('../stripe-webhook.js');
    await handler(event('customer.subscription.updated', sub('sub_live', 'cus_live', 'active', NOW + 29 * DAY)));
    expect(dbFake.table.get('a@b.c')).toMatchObject({ subscription_id: 'sub_live', customer_id: 'cus_live', status: 'active' });
  });
});
