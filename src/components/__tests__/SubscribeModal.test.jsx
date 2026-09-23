// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const ent = { email: null, signIn: vi.fn() };
vi.mock('../../context/EntitlementContext', () => ({ useEntitlement: () => ent }));
vi.mock('../../utils/stripe', () => ({ openCheckout: vi.fn(async () => {}) }));
vi.mock('../../utils/analytics', () => ({ track: () => {} }));
vi.mock('../../utils/platform', () => ({ isNativeApp: () => false }));
vi.mock('../../hooks/useFocusTrap', () => ({ useFocusTrap: () => {} }));

import SubscribeModal from '../SubscribeModal';
import { openCheckout } from '../../utils/stripe';

const alreadySubscribed = () => { const e = new Error('409'); e.code = 'already_subscribed'; throw e; };
const subscribeBtn = () => screen.getByRole('button', { name: /^subscribe$/i });

beforeEach(() => {
  ent.email = null;
  ent.signIn = vi.fn(async () => ({ premium: true, expiresAt: null, source: 'stripe' }));
  openCheckout.mockClear();
  openCheckout.mockImplementation(async () => {});
});
afterEach(() => cleanup());

describe('SubscribeModal — signed in', () => {
  it('passes the signed-in email to checkout and shows no email field', async () => {
    ent.email = 'a@b.c';
    render(<SubscribeModal onClose={() => {}} />);
    expect(screen.queryByRole('textbox', { name: /email/i })).toBeNull();
    fireEvent.click(subscribeBtn());
    await waitFor(() => expect(openCheckout).toHaveBeenCalledWith(expect.any(String), { email: 'a@b.c' }));
  });

  it('explains, instead of charging twice, when that email already has a subscription', async () => {
    ent.email = 'a@b.c';
    openCheckout.mockImplementation(alreadySubscribed);
    render(<SubscribeModal onClose={() => {}} />);
    fireEvent.click(subscribeBtn());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already .*subscription/i));
    expect(screen.getByRole('alert').textContent).toContain('a@b.c');
  });
});

describe('SubscribeModal — signed out (the duplicate-purchase case)', () => {
  it('asks for the email BEFORE going to Stripe, and sends it with the checkout', async () => {
    render(<SubscribeModal onClose={() => {}} />);
    const input = screen.getByRole('textbox', { name: /email/i });
    fireEvent.change(input, { target: { value: '  New@B.C ' } });
    fireEvent.click(subscribeBtn());
    await waitFor(() => expect(openCheckout).toHaveBeenCalledWith(expect.any(String), { email: 'new@b.c' }));
  });

  it('refuses to open checkout without a valid email', async () => {
    render(<SubscribeModal onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: /email/i }), { target: { value: 'not-an-email' } });
    fireEvent.click(subscribeBtn());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/email/i));
    expect(openCheckout).not.toHaveBeenCalled();
  });

  it('signs the person in instead of charging them when the email already has a subscription', async () => {
    openCheckout.mockImplementation(alreadySubscribed);
    const onClose = vi.fn();
    render(<SubscribeModal onClose={onClose} />);
    fireEvent.change(screen.getByRole('textbox', { name: /email/i }), { target: { value: 'a@b.c' } });
    fireEvent.click(subscribeBtn());
    await waitFor(() => expect(ent.signIn).toHaveBeenCalledWith('a@b.c'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('says so when the email is subscribed but sign-in could not confirm it (no silent failure)', async () => {
    openCheckout.mockImplementation(alreadySubscribed);
    ent.signIn = vi.fn(async () => ({ premium: false, expiresAt: null, source: null }));
    const onClose = vi.fn();
    render(<SubscribeModal onClose={onClose} />);
    fireEvent.change(screen.getByRole('textbox', { name: /email/i }), { target: { value: 'a@b.c' } });
    fireEvent.click(subscribeBtn());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already .*subscription/i));
    expect(onClose).not.toHaveBeenCalled();
  });
});
