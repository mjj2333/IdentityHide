// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const ent = { email: null };
vi.mock('../../context/EntitlementContext', () => ({ useEntitlement: () => ent }));
vi.mock('../../utils/stripe', () => ({ openCheckout: vi.fn(async () => {}) }));
vi.mock('../../utils/analytics', () => ({ track: () => {} }));
vi.mock('../../utils/platform', () => ({ isNativeApp: () => false }));
vi.mock('../../hooks/useFocusTrap', () => ({ useFocusTrap: () => {} }));

import SubscribeModal from '../SubscribeModal';
import { openCheckout } from '../../utils/stripe';

beforeEach(() => { ent.email = null; openCheckout.mockClear(); openCheckout.mockImplementation(async () => {}); });
afterEach(() => cleanup());

describe('SubscribeModal', () => {
  it('passes the signed-in email to checkout', async () => {
    ent.email = 'a@b.c';
    render(<SubscribeModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /^subscribe$/i }));
    await waitFor(() => expect(openCheckout).toHaveBeenCalledWith(expect.any(String), { email: 'a@b.c' }));
  });

  it('explains, instead of charging twice, when that email already has a subscription', async () => {
    ent.email = 'a@b.c';
    openCheckout.mockImplementation(async () => { const e = new Error('409'); e.code = 'already_subscribed'; throw e; });
    render(<SubscribeModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /^subscribe$/i }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already .*subscription/i));
    expect(screen.getByRole('alert').textContent).toContain('a@b.c');
  });
});
