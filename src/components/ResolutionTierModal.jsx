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
 * Quality picker — shown as a bottom sheet after a successful upload but
 * before the pipeline starts. Lets the user pick the working megapixel
 * tier, which controls how aggressively the image is downscaled before
 * face detection + Flux inpainting. Tiers larger than the source image
 * are disabled automatically.
 *
 * onSelect contract: called as `onSelect(mp, selectedKey)` on confirm.
 *   - `mp` is the numeric megapixel target (already resolved via getTierMP).
 *   - `selectedKey` is the tier identifier string ('fast' or 'native').
 * Persistence of `selectedKey` to localStorage is handled inside this modal
 * via `saveTierKey(selectedKey)` before onSelect fires.
 */
export default function ResolutionTierModal({ srcWidth, srcHeight, onSelect, onCancel }) {
  const modalRef = useRef(null);
  const confirmRef = useRef(null);
  const onCancelRef = useRef(onCancel);
  useEffect(() => { onCancelRef.current = onCancel; }, [onCancel]);
  useFocusTrap(modalRef);

  const tiers = useMemo(
    () => getAvailableTiers(srcWidth, srcHeight),
    [srcWidth, srcHeight]
  );

  // Pre-select saved tier if still available, otherwise fall back to the
  // first available tier.
  const [selectedKey, setSelectedKey] = useState(() => {
    const saved = getSavedTierKey();
    const savedTier = tiers.find((t) => t.key === saved);
    if (savedTier?.available) return saved;
    const firstAvailable = tiers.find((t) => t.available);
    return firstAvailable?.key || DEFAULT_TIER_KEY;
  });

  const reportedRef = useRef(false);
  useEffect(() => {
    if (reportedRef.current) return;
    reportedRef.current = true;
    const disabledCount = tiers.filter((t) => !t.available).length;
    if (disabledCount > 0) {
      track('tier_disabled_shown', { disabledCount });
    }
  }, [tiers]);

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
      className="sheet-backdrop"
      onClick={handleCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tier-sheet-title"
    >
      <div
        className="sheet-panel tier-sheet"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle" aria-hidden="true" />
        <div className="tier-sheet-heading">
          <h2 id="tier-sheet-title" className="sheet-title">Choose quality</h2>
          <span className="tier-sheet-pill">{srcWidth}×{srcHeight}</span>
        </div>
        <p className="sheet-subtitle">
          Higher quality takes longer. Your photo is processed on-device.
        </p>

        <div className="tier-options" role="radiogroup" aria-label="Resolution tier">
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
                className={`tier-option${isSelected ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}`}
                onClick={() => !disabled && setSelectedKey(tier.key)}
              >
                <span className="tier-option-radio" aria-hidden="true">
                  {isSelected && <span className="tier-option-radio-dot" />}
                </span>
                <span className="tier-option-body">
                  <span className="tier-option-top">
                    <span className="tier-option-label">{tier.label}</span>
                    <span className="tier-option-mp">
                      {tier.mp === Infinity ? 'Original' : `${tier.mp} MP`}
                    </span>
                  </span>
                  <span className="tier-option-sub">
                    {disabled
                      ? 'Photo too small for this option'
                      : <>{tier.desc} · {dims.width}×{dims.height}</>}
                  </span>
                </span>
                <span className="tier-option-time">{tier.time}</span>
              </button>
            );
          })}
        </div>

        <div className="sheet-actions">
          <button type="button" className="btn btn-secondary sheet-cancel" onClick={handleCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="btn btn-primary sheet-confirm"
            onClick={handleConfirm}
          >
            Continue →
          </button>
        </div>
      </div>
    </div>
  );
}
