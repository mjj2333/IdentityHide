// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import ThemeToggle from '../ThemeToggle';

// ThemeToggle renders a two-button segmented pill (Sun / Moon) rather than a
// single toggle button. Tests target each segment by its aria-label.

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});
afterEach(cleanup);

describe('ThemeToggle', () => {
  it('sets data-theme on the <html> element when a segment is clicked', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button', { name: /light mode/i }));
    expect(document.documentElement.dataset.theme).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: /dark mode/i }));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('persists the selected theme to localStorage', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button', { name: /light mode/i }));
    expect(localStorage.getItem('identityhide-theme')).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: /dark mode/i }));
    expect(localStorage.getItem('identityhide-theme')).toBe('dark');
  });

  it('restores the stored theme on mount', () => {
    localStorage.setItem('identityhide-theme', 'light');
    render(<ThemeToggle />);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('marks the active segment with aria-pressed=true', () => {
    localStorage.setItem('identityhide-theme', 'dark');
    render(<ThemeToggle />);
    const lightBtn = screen.getByRole('button', { name: /light mode/i });
    const darkBtn = screen.getByRole('button', { name: /dark mode/i });
    expect(lightBtn.getAttribute('aria-pressed')).toBe('false');
    expect(darkBtn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(lightBtn);
    expect(lightBtn.getAttribute('aria-pressed')).toBe('true');
    expect(darkBtn.getAttribute('aria-pressed')).toBe('false');
  });
});
