import { useEffect, useRef, useState, useMemo } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import {
  getAvailableTiers,
  getSavedTierKey,
  saveTierKey,
  getTierMP,
  DEFAULT_TIER_KEY,
  estimateDimensions,
} from '../utils/resolutionTiers';
import { track } from '../utils/analytics';
import '../styles/ResolutionTierModal.css';

/**
 * Blocking modal shown after a successful upload but before the pipeline
 * starts. Lets the user pick the working megapixel tier, which controls
 * how aggressively the image is downscaled before face detection + Flux
 * inpainting. Tiers larger than the source image are disabled.
 *
 * onSelect contract: called as `onSelect(mp, selectedKey)` on confirm.
 *   - `mp` is the numeric megapixel target (already resolved via getTierMP).
 *   - `selectedKey` is the tier identifier string ('fast' or 'native').
 * Persistence of `selectedKey` to localStorage is handled inside this modal
 * via `saveTierKey(selectedKey)` before onSelect fires — the caller does NOT
 * need to persist it. Callers currently use only `mp` and ignore
 * `selectedKey` (see DropZone.handleTierSelect); the key is emitted anyway
 * so future callers that need it don't have to re-read localStorage.
 */
export default function ResolutionTierModal({ srcWidth, srcHeight, onSelect, onCancel }) {
  const modalRef = useRef(null);
  const confirmRef = useRef(null);
  const onCancelRef = useRef(onCancel);
  useEffect(() => { onCancelRef.current = onCancel; }, [onCancel]);
  useFocusTrap(modalRef);

  // Annotate tiers with availability + effective dimensions for this source.
  const tiers = useMemo(
    () => getAvailableTiers(srcWidth, srcHeight),
    [srcWidth, srcHeight]
  );

  // Pre-select saved tier if still available, otherwise fall back to the
  // largest available tier (which is usually Fast for tiny images).
  const [selectedKey, setSelectedKey] = useState(() => {
    const saved = getSavedTierKey();
    const savedTier = tiers.find((t) => t.key === saved);
    if (savedTier?.available) return saved;
    const firstAvailable = tiers.find((t) => t.available);
    return firstAvailable?.key || DEFAULT_TIER_KEY;
  });

  // Fire one "disabled tiers seen" event per modal open so we can learn how
  // often users upload images too small to benefit from higher tiers.
  const reportedRef = useRef(false);
  useEffect(() => {
    if (reportedRef.current) return;
    reportedRef.current = true;
    const disabledCount = tiers.filter((t) => !t.available).length;
    if (disabledCount > 0) {
      track('tier_disabled_shown', { disabledCount });
    }
  }, [tiers]);

  // Focus the primary button on mount, handle Escape
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onCancelRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const srcMP = (srcWidth * srcHeight) / 1_000_000;
  const submittedRef = useRef(false);

  const handleConfirm = () => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    const mp = getTierMP(selectedKey);
    saveTierKey(selectedKey);
    track('tier_selected', { key: selectedKey, mp, srcMP: Number(srcMP.toFixed(2)) });
    onSelect(mp, selectedKey);
  };

  const handleCancel = () => {
    track('tier_modal_cancelled');
    onCancel();
  };

  return (
    <div
      className="tier-backdrop"
      onClick={handleCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tier-modal-title"
    >
      <div
        className="tier-modal"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="tier-modal-title" className="tier-modal-title">Choose output quality</h2>
        <p className="tier-modal-subtitle">
          Higher quality gives sharper results but takes longer. Your photo: {srcWidth}×{srcHeight}
        </p>

        <div className="tier-grid" role="radiogroup" aria-label="Resolution tier">
          {tiers.map((tier) => {
            const dims = estimateDimensions(srcWidth, srcHeight, tier.mp);
            const isSelected = selectedKey === tier.key;
            const disabled = !tier.available;
            return (
              <button
                key={tier.key}
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-disabled={disabled}
                className={`tier-card${isSelected ? ' tier-card-selected' : ''}${disabled ? ' tier-card-disabled' : ''}`}
                onClick={() => !disabled && setSelectedKey(tier.key)}
              >
                <div className="tier-card-header">
                  <span className="tier-card-label">{tier.label}</span>
                  <span className="tier-card-mp">{tier.time}</span>
                </div>
                <div className="tier-card-dims">
                  {disabled
                    ? 'Photo too small for this option'
                    : `Output: ${dims.width}×${dims.height}`}
                </div>
                <div className="tier-card-desc">{tier.desc}</div>
              </button>
            );
          })}
        </div>

        <div className="tier-modal-actions">
          <button className="btn btn-ghost" onClick={handleCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            className="btn btn-primary"
            onClick={handleConfirm}
          >
            Use this resolution
          </button>
        </div>
      </div>
    </div>
  );
}
