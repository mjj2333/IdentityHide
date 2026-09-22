import { describe, it, expect } from 'vitest';
import {
  listStripeSubscriptions,
  pickEntitlingSubscription,
  rowFromSubscription,
  reconcileFromStripe,
  cancelAllSubscriptions,
} from '../_subscriptionSync.js';

const NOW = Date.parse('2026-09-22T12:00:00Z');
const DAY = 86_400_000;
const secs = (ms) => Math.floor(ms / 1000);

// Minimal stand-ins for the two SDK surfaces the helper touches. Stripe's
// current_period_end lives on the subscription item (2024-12-18+ API) — the
// fakes put it there, with an optional legacy copy on the subscription.
function fakeStripe({ customers = [], subscriptions = [] } = {}) {
  const cancelled = [];
  return {
    cancelled,
    customers: {
      list: async ({ email }) => ({ data: customers.filter((c) => c.email.toLowerCase() === email.toLowerCase()) }),
    },
    subscriptions: {
      list: async ({ customer }) => ({ data: subscriptions.filter((s) => s.customer === customer) }),
      cancel: async (id) => { cancelled.push(id); return { id, status: 'canceled' }; },
    },
  };
}

function sub({ id, customer, status = 'active', created, periodEnd, cancelAtPeriodEnd = false }) {
  return {
    id, customer, status, created: secs(created), cancel_at_period_end: cancelAtPeriodEnd,
    items: { data: [{ current_period_end: secs(periodEnd) }] },
  };
}

// Fake Supabase table keyed by email, recording every write.
function fakeSupabase(rows = []) {
  const table = new Map(rows.map((r) => [r.email, { ...r }]));
  const writes = [];
  const query = (name) => {
    const q = {
      _op: null, _payload: null, _email: null,
      select() { return q; },
      eq(col, val) { if (col === 'email') q._email = val; return q; },
      maybeSingle: async () => ({ data: table.get(q._email) || null, error: null }),
      upsert(row) { q._op = 'upsert'; q._payload = row; return q; },
      update(patch) { q._op = 'update'; q._payload = patch; return q; },
      delete() { q._op = 'delete'; return q; },
      then(resolve) {
        // A terminal await on an upsert/update/delete chain.
        if (q._op === 'upsert') table.set(q._payload.email, { ...(table.get(q._payload.email) || {}), ...q._payload });
        if (q._op === 'update' && table.has(q._email)) table.set(q._email, { ...table.get(q._email), ...q._payload });
        if (q._op === 'delete') table.delete(q._email);
        writes.push({ table: name, op: q._op, email: q._email || q._payload?.email, payload: q._payload });
        resolve({ data: null, error: null });
      },
    };
    return q;
  };
  return { table, writes, from: (name) => query(name) };
}

describe('listStripeSubscriptions', () => {
  it('returns every subscription across every Stripe customer that carries the email, oldest first', async () => {
    const stripe = fakeStripe({
      customers: [{ id: 'cus_A', email: 'x@y.z' }, { id: 'cus_B', email: 'X@Y.Z' }, { id: 'cus_other', email: 'o@y.z' }],
      subscriptions: [
        sub({ id: 'sub_2', customer: 'cus_B', created: NOW - 2 * DAY, periodEnd: NOW + 20 * DAY }),
        sub({ id: 'sub_1', customer: 'cus_A', created: NOW - 200 * DAY, status: 'canceled', periodEnd: NOW - 170 * DAY }),
        sub({ id: 'sub_x', customer: 'cus_other', created: NOW - DAY, periodEnd: NOW + DAY }),
      ],
    });
    const list = await listStripeSubscriptions(stripe, 'x@y.z');
    expect(list.map((s) => s.id)).toEqual(['sub_1', 'sub_2']);
    expect(list[1]).toMatchObject({ customer: 'cus_B', status: 'active', currentPeriodEnd: NOW + 20 * DAY });
  });

  it('reads current_period_end from the subscription itself when the item lacks it (older API shape)', async () => {
    const legacy = { id: 'sub_l', customer: 'cus_A', status: 'active', created: secs(NOW - DAY), cancel_at_period_end: false, current_period_end: secs(NOW + 5 * DAY), items: { data: [{}] } };
    const stripe = fakeStripe({ customers: [{ id: 'cus_A', email: 'x@y.z' }], subscriptions: [legacy] });
    const [s] = await listStripeSubscriptions(stripe, 'x@y.z');
    expect(s.currentPeriodEnd).toBe(NOW + 5 * DAY);
  });

  it('is empty for an email Stripe has never seen', async () => {
    expect(await listStripeSubscriptions(fakeStripe(), 'nobody@y.z')).toEqual([]);
  });
});

describe('pickEntitlingSubscription', () => {
  const mk = (id, status, periodEnd, created) => ({ id, customer: 'c', status, currentPeriodEnd: periodEnd, created, cancelAtPeriodEnd: false });

  it('prefers an active subscription with time left', () => {
    const pick = pickEntitlingSubscription([
      mk('old_canceled', 'canceled', NOW - DAY, NOW - 100 * DAY),
      mk('live', 'active', NOW + 20 * DAY, NOW - 10 * DAY),
    ], NOW);
    expect(pick.id).toBe('live');
  });

  it('takes the NEWEST active one when there are several (the duplicate-checkout case)', () => {
    const pick = pickEntitlingSubscription([
      mk('first', 'active', NOW + 20 * DAY, NOW - 3 * DAY),
      mk('second', 'active', NOW + 20 * DAY, NOW - 2 * DAY),
    ], NOW);
    expect(pick.id).toBe('second');
  });

  it('accepts trialing, and a cancelled subscription whose paid period has not ended yet', () => {
    expect(pickEntitlingSubscription([mk('t', 'trialing', NOW + DAY, NOW)], NOW).id).toBe('t');
    expect(pickEntitlingSubscription([mk('c', 'canceled', NOW + DAY, NOW - 20 * DAY)], NOW).id).toBe('c');
  });

  it('ranks a live subscription above a cancelled-but-still-paid one, whatever their age', () => {
    const pick = pickEntitlingSubscription([
      mk('canceled_new', 'canceled', NOW + 29 * DAY, NOW - DAY),
      mk('active_old', 'active', NOW + 5 * DAY, NOW - 300 * DAY),
    ], NOW);
    expect(pick.id).toBe('active_old');
  });

  it('returns null when nothing grants access (expired, unpaid, incomplete)', () => {
    expect(pickEntitlingSubscription([
      mk('expired', 'canceled', NOW - DAY, NOW - 40 * DAY),
      mk('unpaid', 'unpaid', NOW + DAY, NOW - DAY),
      mk('incomplete', 'incomplete', NOW + DAY, NOW),
      mk('past_due', 'past_due', NOW + DAY, NOW),
    ], NOW)).toBeNull();
    expect(pickEntitlingSubscription([], NOW)).toBeNull();
  });
});

describe('rowFromSubscription', () => {
  it('produces exactly the columns the webhook writes, keyed by lower-cased email', () => {
    const row = rowFromSubscription('  X@Y.Z ', { id: 'sub_1', customer: 'cus_1', status: 'active', currentPeriodEnd: NOW + DAY }, NOW);
    expect(row).toEqual({
      email: 'x@y.z', customer_id: 'cus_1', subscription_id: 'sub_1', status: 'active',
      current_period_end: NOW + DAY, updated_at: new Date(NOW).toISOString(),
    });
  });
});

describe('reconcileFromStripe', () => {
  const stripeWithLive = () => fakeStripe({
    customers: [{ id: 'cus_dead', email: 'x@y.z' }, { id: 'cus_live', email: 'x@y.z' }],
    subscriptions: [
      sub({ id: 'sub_dead', customer: 'cus_dead', status: 'canceled', created: NOW - 3 * DAY, periodEnd: NOW + 27 * DAY }),
      sub({ id: 'sub_live', customer: 'cus_live', created: NOW - 3 * DAY + 1000, periodEnd: NOW + 27 * DAY }),
    ],
  });

  it('creates the missing row from Stripe (the drice233 case)', async () => {
    const db = fakeSupabase([]);
    const result = await reconcileFromStripe({ stripe: stripeWithLive(), supabase: db, email: 'x@y.z', now: NOW });
    expect(result).toMatchObject({ subscription_id: 'sub_live', customer_id: 'cus_live', status: 'active' });
    expect(db.table.get('x@y.z')).toMatchObject({ subscription_id: 'sub_live', current_period_end: NOW + 27 * DAY });
  });

  it('re-points a row stuck on a dead subscription to the live one (the foxdigital case)', async () => {
    const db = fakeSupabase([{ email: 'x@y.z', customer_id: 'cus_dead', subscription_id: 'sub_dead', status: 'canceled', current_period_end: NOW + 27 * DAY }]);
    const result = await reconcileFromStripe({ stripe: stripeWithLive(), supabase: db, email: 'x@y.z', now: NOW });
    expect(result.subscription_id).toBe('sub_live');
    expect(db.table.get('x@y.z').customer_id).toBe('cus_live');
  });

  it('leaves a correct row alone (no write) when Stripe agrees with it', async () => {
    const db = fakeSupabase([{ email: 'x@y.z', customer_id: 'cus_live', subscription_id: 'sub_live', status: 'active', current_period_end: NOW + 27 * DAY }]);
    const result = await reconcileFromStripe({ stripe: stripeWithLive(), supabase: db, email: 'x@y.z', now: NOW });
    expect(result.subscription_id).toBe('sub_live');
    expect(db.writes).toEqual([]);
  });

  it('returns null and writes nothing when Stripe has nothing entitling — never invents access', async () => {
    const stripe = fakeStripe({ customers: [{ id: 'cus_A', email: 'x@y.z' }], subscriptions: [sub({ id: 's', customer: 'cus_A', status: 'canceled', created: NOW - 60 * DAY, periodEnd: NOW - 30 * DAY })] });
    const db = fakeSupabase([]);
    expect(await reconcileFromStripe({ stripe, supabase: db, email: 'x@y.z', now: NOW })).toBeNull();
    expect(db.writes).toEqual([]);
  });

  it('returns null and writes nothing when Stripe cannot be reached', async () => {
    const stripe = { customers: { list: async () => { throw new Error('network'); } }, subscriptions: { list: async () => ({ data: [] }) } };
    const db = fakeSupabase([]);
    expect(await reconcileFromStripe({ stripe, supabase: db, email: 'x@y.z', now: NOW })).toBeNull();
    expect(db.writes).toEqual([]);
  });
});

describe('cancelAllSubscriptions', () => {
  it('cancels every subscription for the email that is still running, across all its customers', async () => {
    const stripe = fakeStripe({
      customers: [{ id: 'cus_A', email: 'x@y.z' }, { id: 'cus_B', email: 'x@y.z' }],
      subscriptions: [
        sub({ id: 'sub_a', customer: 'cus_A', created: NOW - 200 * DAY, periodEnd: NOW + 10 * DAY }),
        sub({ id: 'sub_b', customer: 'cus_B', status: 'trialing', created: NOW - DAY, periodEnd: NOW + 6 * DAY }),
        sub({ id: 'sub_past_due', customer: 'cus_B', status: 'past_due', created: NOW - 40 * DAY, periodEnd: NOW - 10 * DAY }),
        sub({ id: 'sub_gone', customer: 'cus_A', status: 'canceled', created: NOW - 400 * DAY, periodEnd: NOW - 370 * DAY }),
      ],
    });
    const result = await cancelAllSubscriptions(stripe, 'x@y.z');
    expect(stripe.cancelled.sort()).toEqual(['sub_a', 'sub_b', 'sub_past_due']);
    expect(result.cancelled.slice().sort()).toEqual(['sub_a', 'sub_b', 'sub_past_due']);
    expect(result.failed).toEqual([]);
  });

  it('keeps going when one cancel fails, and reports it', async () => {
    const stripe = fakeStripe({
      customers: [{ id: 'cus_A', email: 'x@y.z' }],
      subscriptions: [
        sub({ id: 'sub_bad', customer: 'cus_A', created: NOW - 2 * DAY, periodEnd: NOW + DAY }),
        sub({ id: 'sub_ok', customer: 'cus_A', created: NOW - DAY, periodEnd: NOW + DAY }),
      ],
    });
    const realCancel = stripe.subscriptions.cancel;
    stripe.subscriptions.cancel = async (id) => { if (id === 'sub_bad') throw new Error('boom'); return realCancel(id); };
    const result = await cancelAllSubscriptions(stripe, 'x@y.z');
    expect(result.cancelled).toEqual(['sub_ok']);
    expect(result.failed).toEqual([{ id: 'sub_bad', error: 'boom' }]);
  });
});
