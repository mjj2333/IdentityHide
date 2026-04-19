import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { track } from '../utils/analytics';
import '../styles/CoachMark.css';

const ARROW_SIZE = 8;
const VIEWPORT_PAD = 12;
const SPOTLIGHT_PAD = 6;

/**
 * A single positioned coach-mark bubble that points at a target element.
 * Portal-rendered to escape overflow:hidden containers.
 */
export default function CoachMark({
  targetRef,
  position = 'bottom',
  title,
  body,
  stepIndex,
  totalSteps,
  screenKey,
  onNext,
  onDismiss,
  onDismissAll,
}) {
  const bubbleRef = useRef(null);
  const btnRef = useRef(null);
  const [coords, setCoords] = useState(null);
  const [spotlight, setSpotlight] = useState(null);
  const [actualPos, setActualPos] = useState(position);
  const [announcement, setAnnouncement] = useState('');
  const trackedRef = useRef(false);

  // Track step view once
  useEffect(() => {
    if (!trackedRef.current) {
      trackedRef.current = true;
      track('walkthrough_seen', { screen: screenKey, step: stepIndex + 1 });
    }
  }, [screenKey, stepIndex]);

  // Position the bubble relative to the target
  const reposition = useCallback(() => {
    const target = targetRef?.current;
    const bubble = bubbleRef.current;
    if (!target || !bubble) return;

    const tr = target.getBoundingClientRect();
    const br = bubble.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top, left;
    let pos = position;

    // Calculate preferred position
    if (pos === 'bottom') {
      top = tr.bottom + ARROW_SIZE + 4;
      left = tr.left + tr.width / 2 - br.width / 2;
    } else if (pos === 'top') {
      top = tr.top - br.height - ARROW_SIZE - 4;
      left = tr.left + tr.width / 2 - br.width / 2;
    } else if (pos === 'right') {
      top = tr.top + tr.height / 2 - br.height / 2;
      left = tr.right + ARROW_SIZE + 4;
    } else {
      top = tr.top + tr.height / 2 - br.height / 2;
      left = tr.left - br.width - ARROW_SIZE - 4;
    }

    // If it overflows vertically, flip top↔bottom
    if (pos === 'bottom' && top + br.height > vh - VIEWPORT_PAD) {
      pos = 'top';
      top = tr.top - br.height - ARROW_SIZE - 4;
    } else if (pos === 'top' && top < VIEWPORT_PAD) {
      pos = 'bottom';
      top = tr.bottom + ARROW_SIZE + 4;
    }

    // Clamp horizontal
    left = Math.max(VIEWPORT_PAD, Math.min(left, vw - br.width - VIEWPORT_PAD));
    // Clamp vertical
    top = Math.max(VIEWPORT_PAD, Math.min(top, vh - br.height - VIEWPORT_PAD));

    // Compute arrow offset (center it on the target, clamped to bubble width)
    const arrowLeft = Math.max(16, Math.min(
      tr.left + tr.width / 2 - left,
      br.width - 16
    ));

    setCoords({ top, left, arrowLeft });
    setActualPos(pos);

    // Spotlight rect — follows the target with a little breathing room.
    // Match the target's own border-radius so round buttons get a round
    // cutout. Falls back to the default (10px) in CSS if parsing fails.
    const cs = getComputedStyle(target);
    const parsedRadius = parseFloat(cs.borderRadius);
    setSpotlight({
      top: tr.top - SPOTLIGHT_PAD,
      left: tr.left - SPOTLIGHT_PAD,
      width: tr.width + SPOTLIGHT_PAD * 2,
      height: tr.height + SPOTLIGHT_PAD * 2,
      borderRadius: Number.isFinite(parsedRadius) && parsedRadius > 0
        ? `${parsedRadius + SPOTLIGHT_PAD}px`
        : undefined,
    });
  }, [targetRef, position]);

  // Initial positioning (layout effect to avoid flash)
  useLayoutEffect(() => {
    // Need a frame for the bubble to render and have dimensions
    const raf = requestAnimationFrame(reposition);
    return () => cancelAnimationFrame(raf);
  }, [reposition, stepIndex]);

  // Reposition on resize / viewport changes
  useEffect(() => {
    const vp = window.visualViewport;
    window.addEventListener('resize', reposition);
    vp?.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('resize', reposition);
      vp?.removeEventListener('resize', reposition);
    };
  }, [reposition]);

  // Auto-focus the action button after positioning paint
  useLayoutEffect(() => {
    const raf = requestAnimationFrame(() => btnRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [stepIndex]);

  // Escape key dismisses
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onDismiss]);

  // Skip if target doesn't exist
  useEffect(() => {
    if (!targetRef?.current) {
      const t = setTimeout(onNext, 50);
      return () => clearTimeout(t);
    }
  }, [targetRef, onNext]);

  // Defer pushing text into the live region so screen readers observe a
  // genuine mutation event. NVDA/JAWS won't announce a dynamically-inserted
  // aria-live region that already contains text on first render — they need
  // to see the element before the content arrives. Using an empty string on
  // mount and populating after a tick guarantees that.
  useEffect(() => {
    const text = title ? `${title}. ${body}` : body;
    const t = setTimeout(() => setAnnouncement(text), 80);
    return () => clearTimeout(t);
  }, [title, body, stepIndex]);

  if (!targetRef?.current) return null;

  const isLast = stepIndex >= totalSteps - 1;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const handleNext = () => {
    if (isLast) {
      track('walkthrough_completed', { screen: screenKey });
    }
    onNext();
  };

  const handleDismiss = () => {
    track('walkthrough_skipped', { screen: screenKey, step: stepIndex + 1 });
    onDismiss();
  };

  return createPortal(
    <>
      {spotlight && (
        <div
          className="coach-mark-spotlight"
          style={{
            top: spotlight.top,
            left: spotlight.left,
            width: spotlight.width,
            height: spotlight.height,
            ...(spotlight.borderRadius ? { borderRadius: spotlight.borderRadius } : null),
          }}
        />
      )}
      <div
        ref={bubbleRef}
        className={`coach-mark${reducedMotion ? '' : ' coach-mark-animate'}`}
        style={coords ? { top: coords.top, left: coords.left } : { visibility: 'hidden' }}
      >
        {coords && (actualPos === 'top' || actualPos === 'bottom') && (
          <span
            className={`coach-mark-arrow coach-mark-arrow-${actualPos}`}
            style={{ left: coords.arrowLeft }}
          />
        )}
        {title && <div className="coach-mark-title">{title}</div>}
        <div className="coach-mark-body">{body}</div>
        <div className="coach-mark-footer">
          <span className="coach-mark-step">
            {totalSteps > 1 ? `${stepIndex + 1} of ${totalSteps}` : ''}
          </span>
          <div className="coach-mark-actions">
            {totalSteps > 1 && !isLast && (
              <button className="coach-mark-btn coach-mark-btn-skip" onClick={handleDismiss}>
                Skip
              </button>
            )}
            <button
              ref={btnRef}
              className="coach-mark-btn coach-mark-btn-next"
              onClick={handleNext}
            >
              {isLast ? 'Got it' : 'Next'}
            </button>
          </div>
        </div>
        {onDismissAll && (
          <button className="coach-mark-btn coach-mark-btn-off" onClick={() => {
            track('walkthrough_turned_off', { screen: screenKey, step: stepIndex + 1 });
            onDismissAll();
          }}>
            Turn off all tips
          </button>
        )}
      </div>
      {/* Hidden live region: deferred content push ensures SR observes mutation */}
      <div className="coach-mark-sr-announcer" role="status" aria-live="polite">
        {announcement}
      </div>
    </>,
    document.body
  );
}
