// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('../../utils/analytics', () => ({ track: () => {} }));
import LandingScreen from '../LandingScreen';

afterEach(() => cleanup());

describe('landing store badges', () => {
  it('links both badges to the live store listings (the iOS app was released 2026-10-03)', () => {
    const { container } = render(<LandingScreen onEnter={() => {}} />);
    const hrefs = [...container.querySelectorAll('a.landing-badge-live')].map((a) => a.getAttribute('href'));
    // Country-neutral App Store link: Apple sends each visitor to their own storefront.
    expect(hrefs.filter((h) => h === 'https://apps.apple.com/app/id6791323694')).toHaveLength(2);
    expect(hrefs.filter((h) => h === 'https://play.google.com/store/apps/details?id=com.redactid.app')).toHaveLength(2);
    container.querySelectorAll('a.landing-badge-live').forEach((a) => {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
    });
  });

  it('no longer says the App Store version is coming soon', () => {
    const { container } = render(<LandingScreen onEnter={() => {}} />);
    expect(container.textContent).not.toMatch(/coming soon/i);
    expect(container.querySelector('[aria-label="Download Redact.ID on the App Store"]')).toBeTruthy();
  });
});
