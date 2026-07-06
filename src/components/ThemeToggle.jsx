import { useState, useEffect } from 'react';

// Not renamed when the app rebranded to Redact.ID — changing the key would
// reset every existing user's saved theme preference back to the system
// default. The key name is internal, not user-facing.
const STORAGE_KEY = 'identityhide-theme';

const SunIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />
  </svg>
);

const MoonIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" />
  </svg>
);

/**
 * Theme picker rendered as a two-segment pill (sun / moon).
 * The active segment fills with `--fg` and its glyph flips to `--bg`,
 * per the Redact.ID wordmark row spec.
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return stored;
    } catch {}
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // storage unavailable
    }
  }, [theme]);

  const set = (next) => () => setTheme(next);

  return (
    <div className="theme-pill" role="group" aria-label="Theme">
      <button
        type="button"
        className={`theme-pill__seg${theme === 'light' ? ' is-active' : ''}`}
        aria-pressed={theme === 'light'}
        aria-label="Light mode"
        onClick={set('light')}
      >
        <SunIcon />
      </button>
      <button
        type="button"
        className={`theme-pill__seg${theme === 'dark' ? ' is-active' : ''}`}
        aria-pressed={theme === 'dark'}
        aria-label="Dark mode"
        onClick={set('dark')}
      >
        <MoonIcon />
      </button>
    </div>
  );
}
