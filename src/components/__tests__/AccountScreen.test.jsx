// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const ent = {};
vi.mock('../../context/EntitlementContext', () => ({ useEntitlement: () => ent }));
vi.mock('../../utils/stripe', () => ({ openPortal: vi.fn(async () => {}) }));
vi.mock('../../utils/platform', () => ({ isNativeApp: () => false }));
vi.mock('../ScreenShell', () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock('../RedeemCodeModal', () => ({ default: () => null }));
vi.mock('../SignInModal', () => ({ default: () => null }));
vi.mock('../SubscribeModal', () => ({ default: () => null }));

import AccountScreen from '../AccountScreen';
import { openPortal } from '../../utils/stripe';

beforeEach(() => {
  Object.assign(ent, {
    email: 'a@b.c', betaCode: null, premium: true, expiresAt: Date.now() + 86_400_000, source: 'stripe', loading: false,
    signOut: vi.fn(), deleteAccount: vi.fn(async () => ({ ok: true, cancelled: ['sub_1'], failed: [] })), refreshEntitlement: vi.fn(),
  });
  openPortal.mockClear();
});
afterEach(() => cleanup());

describe('AccountScreen — Stripe subscriber', () => {
  it('offers Cancel subscription next to Manage subscription, opening the portal on the cancel flow', async () => {
    render(<AccountScreen onBack={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel subscription/i }));
    await waitFor(() => expect(openPortal).toHaveBeenCalledWith('a@b.c', { flow: 'cancel' }));
    expect(screen.getByRole('button', { name: /manage subscription/i })).toBeTruthy();
  });

  it('warns in the delete confirmation that cancellation is immediate', () => {
    render(<AccountScreen onBack={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /delete account/i }));
    expect(screen.getByText(/cancelled immediately/i)).toBeTruthy();
  });

  it('tells the user when a subscription could NOT be cancelled during deletion', async () => {
    ent.deleteAccount = vi.fn(async () => ({ ok: true, cancelled: [], failed: ['sub_1'] }));
    render(<AccountScreen onBack={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /delete account/i }));
    fireEvent.click(screen.getAllByRole('button', { name: /delete account/i }).at(-1));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/subscription.*(not|could not).*cancel/i));
  });
});

describe('AccountScreen — promo-code user', () => {
  it('shows no cancel button (nothing to cancel in Stripe)', () => {
    Object.assign(ent, { email: null, betaCode: 'REDACT-XYZ', source: 'beta' });
    render(<AccountScreen onBack={() => {}} />);
    expect(screen.queryByRole('button', { name: /cancel subscription/i })).toBeNull();
  });
});
