// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../analytics', () => ({ track: () => {} }));

let calls;
beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ url: 'https://stripe.test/go' }) };
  }));
  // jsdom can't navigate; swap location for a plain object so the redirect is observable.
  Object.defineProperty(window, 'location', { value: { href: 'http://localhost/', origin: 'http://localhost' }, writable: true, configurable: true });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('openCheckout', () => {
  it('sends the known email so the server can refuse a duplicate purchase or reuse the customer', async () => {
    const { openCheckout } = await import('../stripe');
    await openCheckout('monthly', { email: 'a@b.c' });
    expect(calls[0].body).toEqual({ priceKey: 'monthly', email: 'a@b.c' });
    expect(window.location.href).toBe('https://stripe.test/go');
  });

  it('sends no email when none is known (Stripe collects it)', async () => {
    const { openCheckout } = await import('../stripe');
    await openCheckout('annual');
    expect(calls[0].body).toEqual({ priceKey: 'annual' });
  });

  it('throws an error the UI can recognise when the server says the email is already subscribed', async () => {
    fetch.mockImplementationOnce(async () => ({ ok: false, status: 409, json: async () => ({ error: 'already_subscribed' }) }));
    const { openCheckout } = await import('../stripe');
    await expect(openCheckout('monthly', { email: 'a@b.c' })).rejects.toMatchObject({ code: 'already_subscribed' });
    expect(window.location.href).toBe('http://localhost/');          // no redirect
  });

  it('still throws a plain error for other failures', async () => {
    fetch.mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const { openCheckout } = await import('../stripe');
    await expect(openCheckout('monthly')).rejects.toThrow(/500/);
  });
});

describe('openPortal', () => {
  it('asks for the cancel flow when told to', async () => {
    const { openPortal } = await import('../stripe');
    await openPortal('a@b.c', { flow: 'cancel' });
    expect(calls[0].body).toEqual({ email: 'a@b.c', flow: 'cancel' });
    expect(window.location.href).toBe('https://stripe.test/go');
  });

  it('sends only the email by default', async () => {
    const { openPortal } = await import('../stripe');
    await openPortal('a@b.c');
    expect(calls[0].body).toEqual({ email: 'a@b.c' });
  });
});
