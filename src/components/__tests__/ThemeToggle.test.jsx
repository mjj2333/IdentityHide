// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import ThemeToggle from '../ThemeToggle';

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});
afterEach(cleanup);

describe('ThemeToggle', () => {
  it('toggles data-theme on the <html> element when clicked', () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole('button');
    const start = document.documentElement.dataset.theme;
    fireEvent.click(btn);
    expect(document.documentElement.dataset.theme).not.toBe(start);
    fireEvent.click(btn);
    expect(document.documentElement.dataset.theme).toBe(start);
  });

  it('persists the selected theme to localStorage', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(localStorage.getItem('identityhide-theme')).toBe(
      document.documentElement.dataset.theme
    );
  });

  it('restores the stored theme on mount', () => {
    localStorage.setItem('identityhide-theme', 'light');
    render(<ThemeToggle />);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('exposes an aria-label that reflects the target theme', () => {
    localStorage.setItem('identityhide-theme', 'dark');
    render(<ThemeToggle />);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-label')).toMatch(/light/i);
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-label')).toMatch(/dark/i);
  });
});
