// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import FlagBadge from '../FlagBadge';
import { initFeatureFlags } from '../../utils/featureFlags';

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); localStorage.clear(); initFeatureFlags(''); });

describe('FlagBadge', () => {
  it('renders nothing in the default state (what every normal user sees) — the default-on pair is not news', () => {
    initFeatureFlags('');
    const { container } = render(<FlagBadge />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when the default-on pair is asked for explicitly', () => {
    initFeatureFlags('?cleanfill=1&colorfit=1');
    const { container } = render(<FlagBadge />);
    expect(container.innerHTML).toBe('');
  });

  it('says so on screen when the composite flag is on, so an A/B tester knows which mode ran', () => {
    initFeatureFlags('?composite=1');
    render(<FlagBadge />);
    expect(screen.getByText(/^composite on$/i)).toBeTruthy();
  });

  it('names both when grain matching is on as well', () => {
    initFeatureFlags('?composite=1&grain=1');
    render(<FlagBadge />);
    expect(screen.getByText(/^composite \+ grain$/i)).toBeTruthy();
  });

  it('names mask grow', () => {
    initFeatureFlags('?maskgrow=1');
    render(<FlagBadge />);
    expect(screen.getByText(/^maskgrow on$/i)).toBeTruthy();
  });

  it('says when a default has been switched OFF — that browser is no longer getting what users get', () => {
    initFeatureFlags('?colorfit=0');
    const first = render(<FlagBadge />);
    expect(screen.getByText(/^colorfit off$/i)).toBeTruthy();
    first.unmount();
    initFeatureFlags('?colorfit=1&cleanfill=0');
    render(<FlagBadge />);
    expect(screen.getByText(/^cleanfill off$/i)).toBeTruthy();
  });

  it('names every departure from the defaults when several are combined', () => {
    initFeatureFlags('?cleanfill=0&colorfit=0&maskgrow=1&composite=1&grain=1');
    render(<FlagBadge />);
    expect(screen.getByText(/^cleanfill off \+ maskgrow \+ colorfit off \+ composite \+ grain$/i)).toBeTruthy();
  });

  it('shows nothing when grain was requested without compositing (it has no effect there)', () => {
    initFeatureFlags('?grain=1');
    const { container } = render(<FlagBadge />);
    expect(container.innerHTML).toBe('');
  });
});
