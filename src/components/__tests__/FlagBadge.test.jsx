// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import FlagBadge from '../FlagBadge';
import { initFeatureFlags } from '../../utils/featureFlags';

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); localStorage.clear(); initFeatureFlags(''); });

describe('FlagBadge', () => {
  it('renders nothing when no opt-in flag is on (what every normal user sees)', () => {
    initFeatureFlags('');
    const { container } = render(<FlagBadge />);
    expect(container.innerHTML).toBe('');
  });

  it('says so on screen when the composite flag is on, so an A/B tester knows which mode ran', () => {
    initFeatureFlags('?composite=1');
    render(<FlagBadge />);
    expect(screen.getByText(/composite on/i)).toBeTruthy();
  });

  it('names both when grain matching is on as well', () => {
    initFeatureFlags('?composite=1&grain=1');
    render(<FlagBadge />);
    expect(screen.getByText(/composite \+ grain/i)).toBeTruthy();
  });

  it('names colour fit on its own', () => {
    initFeatureFlags('?colorfit=1');
    render(<FlagBadge />);
    expect(screen.getByText(/^colorfit on$/i)).toBeTruthy();
  });

  it('names every active flag when several are combined', () => {
    initFeatureFlags('?colorfit=1&composite=1&grain=1');
    render(<FlagBadge />);
    expect(screen.getByText(/^colorfit \+ composite \+ grain$/i)).toBeTruthy();
  });

  it('shows nothing when grain was requested without compositing (it has no effect there)', () => {
    initFeatureFlags('?grain=1');
    const { container } = render(<FlagBadge />);
    expect(container.innerHTML).toBe('');
  });
});
