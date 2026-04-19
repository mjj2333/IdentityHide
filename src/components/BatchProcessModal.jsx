import { useEffect, useRef, useState, useMemo } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { hasPaintedPixels } from '../utils/batchProcessor';

// Per-image latency estimates. Numbers are rough averages observed from
// single-image ComfyUI jobs: 1 MP inpaint takes ~30-60s depending on
// model-load cache state; full-resolution takes 3x longer because VAE
// decode dominates at higher megapixel counts.
const QUICK_SECS_PER_TATTOO = 45;
const ORIGINAL_SECS_PER_TATTOO = 180;

function formatMinutes(totalSeconds) {
  if (totalSeconds < 60) return `~${Math.max(1, Math.round(totalSeconds))} sec`;
  const mins = Math.round(totalSeconds / 60);
  return mins === 1 ? '~1 min' : `~${mins} min`;
}

/**
 * Modal shown before a batch process kicks off. Displays a live estimate
 * based on how many images have tattoo masks, and lets the user pick the
 * ComfyUI resolution tier for the tattoo pass.
 *
 * The Quick/Original choice only matters if any image has a tattoo mask —
 * face blur is local and trivially fast at any resolution. Callers skip
 * this modal entirely for batches with no tattoo masks.
 */
export default function BatchProcessModal({ images, defaultTierMP, onConfirm, onCancel }) {
  const modalRef = useRef(null);
  const primaryRef = useRef(null);
  const onCancelRef = useRef(onCancel);
  useEffect(() => { onCancelRef.current = onCancel; }, [onCancel]);
  useFocusTrap(modalRef);

  const { total, tattooCount } = useMemo(() => {
    const total = images.length;
    const tattooCount = images.filter(img => hasPaintedPixels(img.tattooMaskCanvas)).length;
    return { total, tattooCount };
  }, [images]);

  // Start with the user's existing tier if Quick/Original, otherwise default to Quick.
  const initialTier = defaultTierMP && defaultTierMP > 1 ? 'original' : 'quick';
  const [tier, setTier] = useState(initialTier);

  const quickEstimate = tattooCount * QUICK_SECS_PER_TATTOO + (total - tattooCount) * 1;
  const originalEstimate = tattooCount * ORIGINAL_SECS_PER_TATTOO + (total - tattooCount) * 1;

  useEffect(() => {
    primaryRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onCancelRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const tattooLine = tattooCount === 0
    ? `${total} ${total === 1 ? 'image' : 'images'} · face blur only`
    : `${total} ${total === 1 ? 'image' : 'images'} · ${tattooCount} with tattoo mask${tattooCount !== 1 ? 's' : ''}`;

  const handleConfirm = () => {
    onConfirm(tier === 'quick' ? 1 : Infinity);
  };

  return (
    <div className="confirm-backdrop" onClick={onCancel}>
      <div
        className="confirm-modal batch-process-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-process-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="confirm-title" id="batch-process-title">Process Batch</h3>
        <p className="confirm-message">{tattooLine}</p>

        {tattooCount > 0 && (
          <div className="batch-process-tiers" role="radiogroup" aria-label="Processing resolution">
            <button
              type="button"
              role="radio"
              aria-checked={tier === 'quick'}
              className={`batch-process-tier${tier === 'quick' ? ' active' : ''}`}
              onClick={() => setTier('quick')}
            >
              <span className="batch-process-tier-label">Quick (1 MP)</span>
              <span className="batch-process-tier-estimate">{formatMinutes(quickEstimate)}</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={tier === 'original'}
              className={`batch-process-tier${tier === 'original' ? ' active' : ''}`}
              onClick={() => setTier('original')}
            >
              <span className="batch-process-tier-label">Original</span>
              <span className="batch-process-tier-estimate">{formatMinutes(originalEstimate)}</span>
            </button>
          </div>
        )}

        <p className="batch-process-hint">You can cancel anytime — completed images keep their output.</p>

        <div className="confirm-actions">
          <button
            className="btn btn-primary"
            ref={primaryRef}
            onClick={handleConfirm}
          >
            {tattooCount > 0 ? `Process (${formatMinutes(tier === 'quick' ? quickEstimate : originalEstimate)})` : 'Process'}
          </button>
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
