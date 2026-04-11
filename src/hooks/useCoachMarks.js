import { useState, useCallback, useEffect, useRef } from 'react';

const STORAGE_KEY = 'ih_walkthrough';
const SUPPRESS_KEY = 'ih_walkthrough_suppressed';
const SHOW_DELAY = 500;

function readState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; }
}

function writeState(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

function isSuppressed(screenKey) {
  try {
    const s = JSON.parse(sessionStorage.getItem(SUPPRESS_KEY)) || {};
    return !!s[screenKey];
  } catch { return false; }
}

function suppress(screenKey) {
  try {
    const s = JSON.parse(sessionStorage.getItem(SUPPRESS_KEY)) || {};
    s[screenKey] = true;
    sessionStorage.setItem(SUPPRESS_KEY, JSON.stringify(s));
  } catch {}
}

/**
 * Hook for per-screen coach mark walkthrough.
 * @param {string} screenKey - Unique key for this screen ('drop', 'maskEdit', etc.)
 * @param {number} stepCount - Number of steps for this screen
 * @param {object} options
 * @param {boolean} options.skip - If true, suppress this walkthrough (e.g. returning via touch-up)
 */
export function useCoachMarks(screenKey, stepCount, { skip = false } = {}) {
  const [activeStep, setActiveStep] = useState(null);
  const [ready, setReady] = useState(false);
  // Bumped by `restart()` to force the effect below to re-read walkthrough
  // state after it's been reset — lets us replay the coach marks in-place
  // instead of reloading the page.
  const [version, setVersion] = useState(0);
  const timerRef = useRef(null);

  useEffect(() => {
    const state = readState();
    if (state[screenKey] || isSuppressed(screenKey) || skip) {
      setActiveStep(null);
      setReady(true);
      return;
    }
    // Delay showing to avoid flash during screen transitions
    timerRef.current = setTimeout(() => {
      setActiveStep(0);
      setReady(true);
    }, SHOW_DELAY);
    return () => clearTimeout(timerRef.current);
  }, [screenKey, skip, version]);

  const dismiss = useCallback(() => {
    setActiveStep(null);
    const state = readState();
    state[screenKey] = Date.now();
    writeState(state);
    suppress(screenKey);
  }, [screenKey]);

  const next = useCallback(() => {
    setActiveStep(prev => {
      if (prev === null) return null;
      const nextStep = prev + 1;
      if (nextStep >= stepCount) {
        dismiss();
        return null;
      }
      return nextStep;
    });
  }, [stepCount, dismiss]);

  const restart = useCallback(() => {
    resetWalkthrough();
    setReady(false);
    setActiveStep(null);
    setVersion(v => v + 1);
  }, []);

  const isActive = ready && activeStep !== null;

  return { activeStep, totalSteps: stepCount, next, dismiss, isActive, restart };
}

/** Reset all walkthrough state (for testing / replay). */
export function resetWalkthrough() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  try { sessionStorage.removeItem(SUPPRESS_KEY); } catch {}
}
