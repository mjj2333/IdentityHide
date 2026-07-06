import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

// Controlled centered modal. Parent owns the open/close state and renders
// <ColorSpectrumPicker open={...} onClose={...} value={...} onChange={...} />.
// There is no built-in trigger button — that's deliberate, so the picker can
// be opened from anywhere (toolbar menu item, etc.) without affecting layout.
//
// The modal uses position: fixed centered on the viewport, with max
// width/height so it always fits inside the screen even on small phones.
//
// Click-anywhere spectrum: X axis is hue (red → magenta → red), Y axis is
// HSV value × saturation so the top row is pure white, the middle row is
// fully saturated, and the bottom row is pure black. Neutrals (white,
// greys, black) are reachable along the top + bottom edges.
function hsvToHex(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const to255 = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}

function colorAtCoords(xFraction, yFraction) {
  const hue = Math.max(0, Math.min(359.999, xFraction * 360));
  const y = Math.max(0, Math.min(1, yFraction));
  let s, v;
  if (y <= 0.5) {
    s = y / 0.5;
    v = 1;
  } else {
    s = 1;
    v = 1 - (y - 0.5) / 0.5;
  }
  return hsvToHex(hue, s, v);
}

const PRESET_COLORS = [
  '#000000', '#ffffff', '#7a7a7a',
  '#e8384f', '#e8a838', '#3a8f3a', '#3a6fe8', '#a838e8',
];

export default function ColorSpectrumPicker({ open, value, onChange, onClose, ariaLabel = 'Pick a color' }) {
  const spectrumRef = useRef(null);
  const dialogRef = useRef(null);

  // Close on outside (backdrop) click or Escape. Backdrop is rendered
  // explicitly, so its click handler calls onClose; this handler just
  // covers the keyboard path.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Paint the spectrum into the canvas once the modal opens. Per-pixel
  // HSV→hex is expensive (240×140 = 33,600 pixels), but it runs once per
  // open so the cost is acceptable. Putting it inside the open guard
  // means we don't pay the cost while the picker is closed.
  useEffect(() => {
    if (!open) return;
    const canvas = spectrumRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const img = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const hex = colorAtCoords(x / (width - 1), y / (height - 1));
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        const i = (y * width + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [open]);

  const handlePick = useCallback((e) => {
    const canvas = spectrumRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    onChange?.(colorAtCoords(x, y));
  }, [onChange]);

  if (!open) return null;

  // Render through a portal so an ancestor with `transform`, `filter`, or
  // similar can't trap position: fixed inside its containing block. Without
  // this, the editor toolbar or screen shell can accidentally swallow the
  // modal and it never appears on screen.
  return createPortal(
    <div
      className="color-spectrum-backdrop"
      onPointerDown={(e) => {
        // Click on the backdrop (outside the dialog) dismisses.
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        ref={dialogRef}
        className="color-spectrum-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="color-spectrum-header">
          <span
            className="color-spectrum-current"
            style={{ background: value || '#000000' }}
            aria-label={`Current color ${value || '#000000'}`}
          />
          <span className="color-spectrum-title">{ariaLabel}</span>
          <button
            type="button"
            className="color-spectrum-close"
            onClick={onClose}
            aria-label="Close"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <canvas
          ref={spectrumRef}
          width={280}
          height={170}
          className="color-spectrum-canvas"
          onPointerDown={handlePick}
          onPointerMove={(e) => { if (e.buttons === 1) handlePick(e); }}
        />
        <div className="color-spectrum-presets">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`color-spectrum-preset${c === value ? ' is-active' : ''}`}
              style={{ background: c }}
              onClick={() => onChange?.(c)}
              aria-label={`Pick color ${c}`}
            />
          ))}
        </div>
        <div className="color-spectrum-footer">
          <button type="button" className="color-spectrum-done" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
