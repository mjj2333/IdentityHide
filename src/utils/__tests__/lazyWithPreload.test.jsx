// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Suspense } from 'react';
import { render, screen, act, cleanup } from '@testing-library/react';
import { lazyWithPreload } from '../lazyWithPreload';

describe('lazyWithPreload', () => {
  it('renders the module synchronously once preloaded — no Suspense fallback on first commit', async () => {
    const Page = lazyWithPreload(async () => ({ default: () => <h1>FAQ</h1> }));
    await Page.preload();
    render(<Suspense fallback={<p>loading</p>}><Page /></Suspense>);
    expect(screen.getByRole('heading', { name: 'FAQ' })).toBeTruthy();
    expect(screen.queryByText('loading')).toBeNull();
    cleanup();
  });

  it('behaves like React.lazy when not preloaded', async () => {
    const Page = lazyWithPreload(async () => ({ default: () => <h1>Terms</h1> }));
    render(<Suspense fallback={<p>loading</p>}><Page /></Suspense>);
    expect(screen.getByText('loading')).toBeTruthy();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByRole('heading', { name: 'Terms' })).toBeTruthy();
    cleanup();
  });

  it('loads the module only once however often preload is called', async () => {
    let calls = 0;
    const Page = lazyWithPreload(async () => { calls++; return { default: () => null }; });
    await Promise.all([Page.preload(), Page.preload()]);
    await Page.preload();
    expect(calls).toBe(1);
  });
});
