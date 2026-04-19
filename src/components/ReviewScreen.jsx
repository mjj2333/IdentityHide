import { useRef, useEffect, useState, useCallback } from 'react';
import { usePipeline } from '../context/PipelineContext';
import { applyMaskedBlur, stackBlur, FACE_BOX_EXPAND } from '../utils/blurEngine';
import { track } from '../utils/analytics';
import { useZoomPan } from '../hooks/useZoomPan';
import { useCoachMarks, suppressAllWalkthroughs } from '../hooks/useCoachMarks';
import ScreenShell from './ScreenShell';
import CoachMark from './CoachMark';
import ConfirmModal from './ConfirmModal';

export default function ReviewScreen() {
  const {
    outputCanvasRef,
    originalCanvasRef,
    inpaintedCanvasRef,
    tattooMaskCanvasRef,
    faceBlurCanvasRef,
    tattooMaskDirtyRef,
    editDets,
    metadata,
    blurSettings,
    feather,
    setScreen,
    setEditorReturnMode,
  } = usePipeline();

  const previewRef = useRef(null);
  const originalPreviewRef = useRef(null);
  const canvasWrapRef = useRef(null);
  const dividerRef = useRef(null);
  const touchUpRef = useRef(null);

  const isMobile = /Mobi|Android/i.test(navigator.userAgent);

  const COACH_STEPS = [
    { targetRef: dividerRef, position: 'bottom', title: 'Compare before & after', body: isMobile
      ? 'Slide the divider to compare the original with your protected version.'
      : 'Drag the divider to compare the original with your protected version.' },
    { targetRef: touchUpRef, position: 'top', title: 'Need adjustments?', body: 'Tap Touch Up to go back and refine your masks.' },
  ];
  const coachMarks = useCoachMarks('review', COACH_STEPS.length);

  const imgW = inpaintedCanvasRef.current?.width || 1;
  const imgH = inpaintedCanvasRef.current?.height || 1;
  const {
    getTransformStyle,
    handleTouchStart: zoomTouchStart,
    handleTouchMove: zoomTouchMove,
    handleTouchEnd: zoomTouchEnd,
  } = useZoomPan(imgW, imgH, canvasWrapRef, { oneFingerPan: true });

  const [splitPos, setSplitPos] = useState(50);
  const [renderTick, setRenderTick] = useState(0);
  const [showTouchUpConfirm, setShowTouchUpConfirm] = useState(false);

  const editDetsRef = useRef(editDets);
  const blurSettingsRef = useRef(blurSettings);
  useEffect(() => { editDetsRef.current = editDets; }, [editDets]);
  useEffect(() => { blurSettingsRef.current = blurSettings; }, [blurSettings]);

  const buildCombinedMask = useCallback((dets, blurMode) => {
    const base = inpaintedCanvasRef.current;
    if (!base) return null;
    const { width, height } = base;
    const mask = document.createElement('canvas');
    mask.width = width;
    mask.height = height;
    const ctx = mask.getContext('2d');

    // Skip shapes for blackbar — bars are drawn directly from detections
    if (blurMode !== 'blackbar') {
      for (const det of dets) {
        ctx.fillStyle = 'white';
        if (det.shape === 'rectangle') {
          const w = (det.bottomRight[0] - det.topLeft[0]) * FACE_BOX_EXPAND;
          const h = (det.bottomRight[1] - det.topLeft[1]) * FACE_BOX_EXPAND;
          const cx = (det.topLeft[0] + det.bottomRight[0]) / 2;
          const cy = (det.topLeft[1] + det.bottomRight[1]) / 2;
          ctx.fillRect(cx - w/2, cy - h/2, w, h);
        } else {
          const cx = (det.topLeft[0] + det.bottomRight[0]) / 2;
          const cy = (det.topLeft[1] + det.bottomRight[1]) / 2;
          const rx = (det.bottomRight[0] - det.topLeft[0]) / 2 * FACE_BOX_EXPAND;
          const ry = (det.bottomRight[1] - det.topLeft[1]) / 2 * FACE_BOX_EXPAND;
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    if (faceBlurCanvasRef.current) {
      ctx.drawImage(faceBlurCanvasRef.current, 0, 0);
    }

    const fr = feather;
    if (fr > 0) {
      const imgData = ctx.getImageData(0, 0, width, height);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = d[i + 3];
        d[i + 1] = d[i + 3];
        d[i + 2] = d[i + 3];
      }
      stackBlur(imgData, fr);
      for (let i = 0; i < d.length; i += 4) {
        d[i + 3] = d[i];
        d[i] = 255;
        d[i + 1] = 255;
        d[i + 2] = 255;
      }
      ctx.putImageData(imgData, 0, 0);
    }

    return mask;
  }, [inpaintedCanvasRef, faceBlurCanvasRef, feather]);

  const applyFullBlur = useCallback((dets) => {
    const base = inpaintedCanvasRef.current;
    if (!base) return;

    const { mode, strength } = blurSettingsRef.current;
    const mask = buildCombinedMask(dets, mode);
    if (!mask) return;

    const mCtx = mask.getContext('2d');
    const mData = mCtx.getImageData(0, 0, mask.width, mask.height);
    let hasMask = false;
    for (let i = 0; i < mData.data.length; i += 4) {
      if (mData.data[i + 3] > 0) { hasMask = true; break; }
    }

    // For blackbar, still need to draw bars even if mask is empty
    const needsBlur = hasMask || (mode === 'blackbar' && dets.length > 0);

    if (!needsBlur) {
      const clean = document.createElement('canvas');
      clean.width = base.width;
      clean.height = base.height;
      clean.getContext('2d').drawImage(base, 0, 0);
      outputCanvasRef.current = clean;
    } else {
      const barSettings = mode === 'blackbar' ? { width: blurSettingsRef.current.barWidth ?? 20, length: blurSettingsRef.current.barLength ?? 110, angle: blurSettingsRef.current.barAngle ?? 0 } : null;
      outputCanvasRef.current = applyMaskedBlur(base, mask, mode, strength, dets, barSettings);
    }
    setRenderTick(t => t + 1);
  }, [inpaintedCanvasRef, outputCanvasRef, buildCombinedMask]);

  const appliedOnceRef = useRef(false);
  useEffect(() => {
    if (appliedOnceRef.current) return;
    if (!inpaintedCanvasRef.current) return;
    appliedOnceRef.current = true;
    track('review_entered', { face_count: editDetsRef.current.length });
    applyFullBlur(editDetsRef.current);
  }, []);

  useEffect(() => {
    const preview = previewRef.current;
    const source = outputCanvasRef.current;
    if (!preview || !source) return;
    preview.width = source.width;
    preview.height = source.height;
    preview.getContext('2d').drawImage(source, 0, 0);
  }, [outputCanvasRef, renderTick]);

  useEffect(() => {
    const preview = originalPreviewRef.current;
    const source = originalCanvasRef.current;
    if (!preview || !source) return;
    preview.width = source.width;
    preview.height = source.height;
    preview.getContext('2d').drawImage(source, 0, 0);
  }, [originalCanvasRef]);

  // AbortController for compare-drag listeners — abort() atomically
  // removes all listeners, eliminating the race between onUp and unmount.
  const dragAbortRef = useRef(null);

  const handleCompareDown = useCallback((e) => {
    e.preventDefault();
    const canvas = previewRef.current;
    if (!canvas) return;
    // Abort any in-flight drag (cleans up all its listeners atomically).
    dragAbortRef.current?.abort();
    const ac = new AbortController();
    dragAbortRef.current = ac;
    const opts = { signal: ac.signal };
    window.addEventListener('pointermove', (ev) => {
      const rect = canvas.getBoundingClientRect();
      const x = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPos(Math.max(0, Math.min(100, x)));
    }, opts);
    window.addEventListener('pointerup', () => ac.abort(), opts);
    window.addEventListener('pointercancel', () => ac.abort(), opts);
  }, []);

  // Guarantee cleanup if the component unmounts mid-drag.
  useEffect(() => () => { dragAbortRef.current?.abort(); }, []);

  const handleCompareKey = useCallback((e) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      setSplitPos(v => Math.max(0, v - step));
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      setSplitPos(v => Math.min(100, v + step));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setSplitPos(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setSplitPos(100);
    }
  }, []);

  const handleBack = useCallback(() => {
    track('review_back');
    setEditorReturnMode('tattoo');
    setScreen('mask-edit');
  }, [setScreen, setEditorReturnMode]);

  const handleTouchUp = useCallback(() => {
    setShowTouchUpConfirm(true);
  }, []);

  const confirmTouchUp = useCallback(() => {
    track('review_touch_up');
    // Clear tattoo mask for fresh touch-up painting on the inpainted result.
    // The previous strokes were already baked into the result, and the mask
    // editor's background is now the inpainted image, so carrying them over
    // would draw "remove this" marks over areas that are already clean.
    if (tattooMaskCanvasRef.current) {
      const ctx = tattooMaskCanvasRef.current.getContext('2d');
      ctx.clearRect(0, 0, tattooMaskCanvasRef.current.width, tattooMaskCanvasRef.current.height);
    }
    tattooMaskDirtyRef.current = true;
    setShowTouchUpConfirm(false);
    setEditorReturnMode('tattoo');
    setScreen('mask-edit');
  }, [setScreen, setEditorReturnMode, tattooMaskCanvasRef, tattooMaskDirtyRef]);

  // --- Metadata report ---
  const metadataRows = metadata ? [
    { label: 'GPS Location', value: metadata.gps ? `${metadata.gps.lat}, ${metadata.gps.lng}${metadata.gps.alt != null ? ` (${metadata.gps.alt}m)` : ''}` : null, warn: true },
    { label: 'Camera', value: metadata.camera },
    { label: 'Date / Time', value: metadata.dateTime },
    { label: 'Software', value: metadata.software },
    { label: 'Focal Length', value: metadata.focalLength },
    { label: 'Lens', value: metadata.lens },
    { label: 'Orientation', value: metadata.orientation != null ? `${metadata.orientation}` : null },
  ] : [];
  const strippedRows = metadataRows.filter(r => r.value != null);

  return (
    <ScreenShell
      stepLabel="Review"
      backAction={handleBack}
      backLabel="Back"
      primaryAction={() => setScreen('export')}
      primaryLabel="Export"
    >
      <div className="review-canvas-area">
        <div
          className="review-canvas-wrap"
          ref={canvasWrapRef}
          onTouchStart={zoomTouchStart}
          onTouchMove={zoomTouchMove}
          onTouchEnd={zoomTouchEnd}
        >
          <div
            className="review-zoom-wrapper"
            style={{ transform: getTransformStyle(), transformOrigin: 'center center' }}
          >
            <div className="review-canvas-container">
              <canvas ref={previewRef} className="review-canvas" aria-label="Protected image preview" />
              <canvas
                ref={originalPreviewRef}
                className="review-canvas compare-original"
                aria-label="Original image for comparison"
                style={{ clipPath: `inset(0 ${100 - splitPos}% 0 0)` }}
              />
              <div
                ref={dividerRef}
                className="compare-divider"
                style={{ left: `${splitPos}%` }}
                role="slider"
                aria-label="Compare original and protected"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(splitPos)}
                tabIndex={0}
                onPointerDown={handleCompareDown}
                onKeyDown={handleCompareKey}
              >
                <div className="compare-divider-grip" aria-hidden="true">
                  <svg width="7" height="12" viewBox="0 0 7 12" fill="currentColor"><path d="M5.5 0L0 6l5.5 6z"/></svg>
                  <svg width="7" height="12" viewBox="0 0 7 12" fill="currentColor"><path d="M1.5 0L7 6l-5.5 6z"/></svg>
                </div>
              </div>
            </div>
          </div>
          <span className="compare-tag compare-tag-left">Original</span>
          <span className="compare-tag compare-tag-right">Protected</span>
        </div>
      </div>

      <div className="review-touch-up-area">
        <button ref={touchUpRef} className="btn btn-secondary review-touch-up-btn" onClick={handleTouchUp}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19l7-7 3 3-7 7-3-3z" />
            <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
          </svg>
          Touch Up
        </button>
      </div>

      {metadata && (
        <div className="privacy-report">
          <div className="privacy-report-header">
            <svg className="privacy-report-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <span className="privacy-report-title">
              {strippedRows.length > 0
                ? 'Metadata Detected & Removed'
                : metadata.readable !== false
                  ? 'No Metadata Detected'
                  : 'Metadata Stripped'}
            </span>
            <span className="privacy-report-summary">
              {strippedRows.length > 0
                ? `${strippedRows.length} field${strippedRows.length > 1 ? 's' : ''} stripped`
                : 'Clean'}
            </span>
          </div>

          <div className="privacy-report-body">
            {strippedRows.length > 0 ? (
              <div className="privacy-report-grid">
                {metadataRows.map(row => (
                  <div className={`privacy-report-row${row.value != null ? ' found' : ''}${row.warn && row.value != null ? ' warn' : ''}`} key={row.label}>
                    <span className="privacy-report-label">{row.label}</span>
                    <span className="privacy-report-value">
                      {row.value != null ? row.value : 'Not present'}
                    </span>
                    <span className="privacy-report-status">
                      {row.value != null ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-label="Stripped">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        <span className="privacy-report-dash">&mdash;</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="privacy-report-clean">
                {metadata.note || 'No sensitive metadata found in this image. Output is clean.'}
              </div>
            )}
          </div>
        </div>
      )}

      {coachMarks.isActive && COACH_STEPS[coachMarks.activeStep] && (
        <CoachMark
          {...COACH_STEPS[coachMarks.activeStep]}
          stepIndex={coachMarks.activeStep}
          totalSteps={coachMarks.totalSteps}
          screenKey="review"
          onNext={coachMarks.next}
          onDismiss={coachMarks.dismiss}
          onDismissAll={() => { suppressAllWalkthroughs(); coachMarks.dismiss(); }}
        />
      )}

      {showTouchUpConfirm && (
        <ConfirmModal
          message="Touch up starts with a fresh mask over your current result. Your previous mask strokes are cleared. Continue?"
          confirmLabel="Clear & Touch Up"
          onConfirm={confirmTouchUp}
          onCancel={() => setShowTouchUpConfirm(false)}
        />
      )}
    </ScreenShell>
  );
}
