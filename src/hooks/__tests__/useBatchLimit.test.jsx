// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const env = vi.hoisted(() => ({ premium: false, testerBuild: false }));
vi.mock('../../context/EntitlementContext', () => ({ useEntitlement: () => ({ premium: env.premium }) }));
vi.mock('../../utils/buildChannel', () => ({ isAdFreeBuild: async () => env.testerBuild }));

import { useBatchLimit } from '../useBatchLimit';

beforeEach(() => { env.premium = false; env.testerBuild = false; });

describe('useBatchLimit', () => {
  it('gives free users 3 photos per batch', async () => {
    const { result } = renderHook(() => useBatchLimit());
    await waitFor(() => expect(result.current).toEqual({ limit: 3, full: false }));
  });

  it('gives Premium users 20', () => {
    env.premium = true;
    const { result } = renderHook(() => useBatchLimit());
    expect(result.current).toEqual({ limit: 20, full: true });
  });

  it('gives testers on a TestFlight build 20 without Premium', async () => {
    env.testerBuild = true;
    const { result } = renderHook(() => useBatchLimit());
    await waitFor(() => expect(result.current).toEqual({ limit: 20, full: true }));
  });
});
