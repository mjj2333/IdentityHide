import { useEffect, useRef } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';

export default function ConfirmModal({
  message,
  confirmLabel = 'Yes, continue',
  confirmVariant = 'danger',
  onConfirm,
  onCancel,
}) {
  const modalRef = useRef(null);
  const cancelRef = useRef(null);
  // Keep the latest onCancel in a ref so the Escape listener (which is bound
  // once on mount) always invokes the current callback even if the parent
  // swaps it between renders.
  const onCancelRef = useRef(onCancel);
  useEffect(() => { onCancelRef.current = onCancel; }, [onCancel]);
  useFocusTrap(modalRef);

  // Focus cancel button on mount, trap Escape key
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onCancelRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="confirm-backdrop" onClick={onCancel}>
      <div className="confirm-modal" ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="confirm-modal-msg" onClick={(e) => e.stopPropagation()}>
        <p className="confirm-message" id="confirm-modal-msg">{message}</p>
        <div className="confirm-actions">
          <button className={`btn btn-${confirmVariant}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
          <button className="btn btn-secondary" ref={cancelRef} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
