// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

let native = false;
vi.mock('../ScreenShell', () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock('../../utils/platform', () => ({ isNativeApp: () => native }));
import FaqScreen from '../FaqScreen';

afterEach(() => { cleanup(); native = false; });

describe('FAQ premium answer', () => {
  it('no longer says Premium is "coming soon" — subscriptions are live on the web', () => {
    const { container } = render(<FaqScreen />);
    expect(container.textContent).not.toMatch(/coming soon/i);
    const ld = container.querySelector('script[type="application/ld+json"]').textContent;
    expect(ld).not.toMatch(/coming soon/i);
  });

  it('states the real batch limits (3 photos free, 20 with Premium)', () => {
    const { container } = render(<FaqScreen />);
    const q = [...container.querySelectorAll('.faq-question')].find((b) => /premium plan/i.test(b.textContent));
    const answer = document.getElementById(q.getAttribute("aria-controls")).textContent;
    expect(answer).toMatch(/20 photos/);
    expect(answer).toMatch(/3/);
  });

  it('is still hidden in the native apps (Apple 3.1.1: no promoting a tier with no in-app purchase)', () => {
    native = true;
    const { container } = render(<FaqScreen />);
    expect(container.textContent).not.toMatch(/premium plan/i);
  });
});
