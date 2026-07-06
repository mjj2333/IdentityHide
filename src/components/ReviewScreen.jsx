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
    { targetRef: touchUpRef, position: 'top', title: 'Need adjustments?', body: 'Tap Touch Up to re-open the editor and adjust further.' },
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
  // The metadata card is a collapsed accordion by default so the before/after
  // compare window gets the majority of the vertical space. Users who want
  // the full audit of which fields were stripped can expand it.
  const [metaExpanded, setMetaExpanded] = useState(false);

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

    // Only blur-kind regions paint into the blur mask (stickers are separate).
    if (blurMode !== 'blackbar') {
      for (const det of dets) {
        if (det.kind === 'sticker') continue;
        ctx.fillStyle = 'white';
        const cx = (det.topLeft[0] + det.bottomRight[0]) / 2;
        const cy = (det.topLeft[1] + det.bottomRight[1]) / 2;
        const rx = (det.bottomRight[0] - det.topLeft[0]) / 2 * FACE_BOX_EXPAND;
        const ry = (det.bottomRight[1] - det.topLeft[1]) / 2 * FACE_BOX_EXPAND;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (faceBlurCanvasRef.current) {
      ctx.drawImage(faceBlurCanvasRef.current, 0, 0);
    }

    const fr = feather;
    if (fr > 0 && blurMode !== 'blackbar') {
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

    const bs = blurSettingsRef.current;
    const { mode, strength } = bs;
    const stickerEnabled = !!bs.stickerEnabled; // freehand color-brush flag
    const wantBlur = mode === 'gaussian' || mode === 'pixelate';

    const hasPixels = (m) => {
      const d = m.getContext('2d').getImageData(0, 0, m.width, m.height).data;
      for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) return true; }
      return false;
    };

    const blurDets = dets.filter(d => d.kind !== 'sticker');
    const stickerObjects = dets.filter(d => d.kind === 'sticker');
    const blurMask = wantBlur ? buildCombinedMask(blurDets, 'gaussian') : null;
    const freehandStickerMask = stickerEnabled ? buildCombinedMask([], 'blackbar') : null;

    const hasBlur = !!blurMask && hasPixels(blurMask);
    const hasSticker = stickerObjects.length > 0 || (!!freehandStickerMask && hasPixels(freehandStickerMask));

    if (!hasBlur && !hasSticker) {
      const clean = document.createElement('canvas');
      clean.width = base.width;
      clean.height = base.height;
      clean.getContext('2d').drawImage(base, 0, 0);
      outputCanvasRef.current = clean;
    } else {
      outputCanvasRef.current = applyMaskedBlur(
        base, blurMask, wantBlur ? mode : 'none', strength,
        stickerObjects, freehandStickerMask, bs.barColor || '#000000',
      );
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
  // Each row is just a label + whether the field was present on the source.
  // The actual values are deliberately NOT surfaced — showing the GPS
  // coordinates or camera model even in a "this was stripped" summary
  // undermines the point of stripping them.
  const metadataRows = metadata ? [
    { label: 'GPS location',    present: !!metadata.gps },
    { label: 'Camera body',     present: metadata.camera != null },
    { label: 'Lens',            present: metadata.lens != null },
    { label: 'Software',        present: metadata.software != null },
    { label: 'Date / time',     present: metadata.dateTime != null },
    { label: 'Focal length',    present: metadata.focalLength != null },
    { label: 'Orientation',     present: metadata.orientation != null },
  ] : [];

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
        <button ref={touchUpRef} className="review-touch-up-btn" onClick={handleTouchUp}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
          </svg>
          Touch Up
        </button>
      </div>

      {metadata && (
        <div className={`metadata-report${metaExpanded ? ' is-open' : ''}`}>
          <button
            type="button"
            className="metadata-report-header"
            onClick={() => setMetaExpanded(v => !v)}
            aria-expanded={metaExpanded}
            aria-controls="metadata-report-rows"
          >
            <svg className="metadata-report-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
            </svg>
            <h3 className="metadata-report-title">Metadata Stripped</h3>
            <span className="metadata-report-summary">
              {metadataRows.filter(r => r.present).length} removed
            </span>
            <svg className="metadata-report-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points={metaExpanded ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
            </svg>
          </button>
          {metaExpanded && (
            <div className="metadata-report-rows" id="metadata-report-rows">
              {metadataRows.map(row => (
                <div className="metadata-report-row" key={row.label}>
                  <span className="metadata-report-label">{row.label}</span>
                  <span className={`metadata-report-status${row.present ? ' is-removed' : ''}`}>
                    {row.present ? 'Removed' : 'Not present'}
                  </span>
                </div>
              ))}
            </div>
          )}
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
