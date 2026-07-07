import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { usePipeline } from '../context/PipelineContext';
import { useImagePipeline } from '../hooks/useImagePipeline';
import { canvasToBlob, downloadBlob, generateExportFilename } from '../utils/imageHelpers';
import { track } from '../utils/analytics';
import { isNativeApp } from '../utils/platform';
import { shareNativeFile } from '../utils/nativeMedia';
import { useZoomPan } from '../hooks/useZoomPan';
import { useCoachMarks, suppressAllWalkthroughs } from '../hooks/useCoachMarks';
import { useFocusTrap } from '../hooks/useFocusTrap';
import ScreenShell from './ScreenShell';
import CoachMark from './CoachMark';

/**
 * Post-export "What's next?" prompt. Rendered only when open so useFocusTrap
 * captures the container ref on mount. Mirrors ConfirmModal's a11y pattern:
 * role=dialog, aria-modal, Escape-to-dismiss, focus trap, backdrop click,
 * and safe-default focus on the dismiss button so accidental Enter doesn't
 * discard the user's just-exported work.
 */
function FeedbackPrompt({ onEditAnother, onDismiss, onGiveFeedback }) {
  const modalRef = useRef(null);
  const dismissRef = useRef(null);
  const previouslyFocusedRef = useRef(null);
  const onDismissRef = useRef(onDismiss);
  useEffect(() => { onDismissRef.current = onDismiss; }, [onDismiss]);
  useFocusTrap(modalRef);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement;
    dismissRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onDismissRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function' && document.body.contains(prev)) {
        prev.focus();
      }
    };
  }, []);

  return (
    <div className="confirm-backdrop" onClick={onDismiss}>
      <div
        className="confirm-modal feedback-prompt"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-prompt-title"
        aria-describedby="feedback-prompt-text"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="feedback-prompt-title" id="feedback-prompt-title">What&apos;s next?</p>
        <div className="feedback-prompt-actions">
          {/* "Return to Export" is the visual primary to match the auto-focused
           * safe default — "Edit Another Photo" resets the pipeline, so putting
           * the primary styling on it would contradict the accidental-Enter
           * guard documented on the component above. */}
          <button className="btn btn-primary" ref={dismissRef} onClick={onDismiss}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Return to Export
          </button>
          <button className="btn btn-secondary" onClick={onEditAnother}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
            </svg>
            Edit Another Photo
          </button>
          <div className="feedback-prompt-divider" />
          <p className="feedback-prompt-text" id="feedback-prompt-text">Your feedback directly shapes what we build next.</p>
          <button className="btn btn-secondary" onClick={onGiveFeedback}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
            </svg>
            Give Feedback
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ExportScreen({ onFeedback }) {
  const {
    outputCanvasRef,
    originalCanvasRef,
    setScreen,
    reset,
  } = usePipeline();

  const { buildExportOutput } = useImagePipeline();

  const previewRef = useRef(null);
  const canvasWrapRef = useRef(null);
  const downloadBtnRef = useRef(null);
  const mountedRef = useRef(true);

  const COACH_STEPS = [
    { targetRef: downloadBtnRef, position: 'top', title: 'Save your image', body: 'Choose a format, then download or share. All metadata has been stripped.' },
  ];
  const coachMarks = useCoachMarks('export', COACH_STEPS.length);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const imgW = outputCanvasRef.current?.width || 1;
  const imgH = outputCanvasRef.current?.height || 1;
  const {
    getTransformStyle,
    handleTouchStart: zoomTouchStart,
    handleTouchMove: zoomTouchMove,
    handleTouchEnd: zoomTouchEnd,
  } = useZoomPan(imgW, imgH, canvasWrapRef, { oneFingerPan: true });
  const [format, setFormat] = useState('jpeg');
  const [quality, setQuality] = useState(95);
  const [showOriginal, setShowOriginal] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [fileSize, setFileSize] = useState(null);
  const [showFeedbackPrompt, setShowFeedbackPrompt] = useState(false);
  const [exportError, setExportError] = useState(null);

  // Whether the "Share" affordance should appear instead of just download:
  //   - Native shell: always (the OS share sheet is the right primitive)
  //   - iOS web: only when the browser exposes Web Share with files (the
  //     only path to land a processed image in Photos on iOS Safari)
  //   - Android/desktop web: keep just the plain download CTA
  const isIOS = useMemo(() => /iPad|iPhone|iPod/.test(navigator.userAgent), []);
  const canShare = useMemo(() => {
    if (isNativeApp()) return true;
    if (!isIOS) return false;
    if (typeof navigator === 'undefined' || !navigator.share || !navigator.canShare) return false;
    try {
      const testFile = new File(['test'], 'test.png', { type: 'image/png' });
      return navigator.canShare({ files: [testFile] });
    } catch {
      return false;
    }
  }, [isIOS]);

  useEffect(() => {
    const canvas = previewRef.current;
    const output = outputCanvasRef.current;
    const source = showOriginal ? originalCanvasRef.current : output;
    if (!canvas || !source || !output) return;
    // Always size the preview canvas to the output (tier) resolution so
    // toggling between original and edited shows the tattoo/face changes
    // without the canvas physically resizing.
    canvas.width = output.width;
    canvas.height = output.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Center-crop the source to the output's aspect ratio before scaling it
    // into the preview canvas. The pipeline's 16-pixel alignment in
    // downscaleToMegapixels causes the output aspect to drift ~0.5% from
    // the source; without this crop, toggling to "original" stretches the
    // image and the content shifts a pixel or two — visible as a subtle
    // "size change" during compare. When showing the edited result, source
    // === output so the crop math is a no-op.
    const outAspect = output.width / output.height;
    const srcAspect = source.width / source.height;
    let sx = 0, sy = 0, sw = source.width, sh = source.height;
    if (srcAspect > outAspect) {
      sw = source.height * outAspect;
      sx = (source.width - sw) / 2;
    } else if (srcAspect < outAspect) {
      sh = source.width / outAspect;
      sy = (source.height - sh) / 2;
    }
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, output.width, output.height);
  }, [showOriginal, outputCanvasRef, originalCanvasRef]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const fullRes = await buildExportOutput();
      if (cancelled || !fullRes) return;
      const mimeType = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
      const blob = await canvasToBlob(fullRes, mimeType, quality / 100);
      if (!cancelled) setFileSize(blob.size);
    })().catch(() => { if (!cancelled) setFileSize(null); });
    return () => { cancelled = true; };
  }, [format, quality, buildExportOutput]);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    setExportError(null);
    // 60s ceiling — if buildExportOutput or canvasToBlob ever stalls (e.g.
    // upstream ComfyUI hang on a touch-up, or a pathological huge encode),
    // surface a recoverable error rather than leaving the button stuck on
    // "Building...".
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('timeout')), 60_000);
    });
    try {
      const fullResOutput = await Promise.race([buildExportOutput(), timeout]);
      if (!fullResOutput) throw new Error('no-output');
      const ext = format === 'jpeg' ? 'jpg' : format;
      const mimeType = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
      const blob = await Promise.race([canvasToBlob(fullResOutput, mimeType, quality / 100), timeout]);
      const filename = generateExportFilename(ext);
      // On native shells the OS share sheet is the right idiom for "save"
      // — it covers Photos, Files, AirDrop, third-party apps. A plain
      // download (which on web triggers a Blob download) doesn't have an
      // analog on iOS/Android; the native bridge replaces it.
      if (isNativeApp()) {
        const { shared } = await shareNativeFile(blob, filename, mimeType);
        if (shared) {
          track('export_completed', { format, quality, action: 'share' });
          if (mountedRef.current) setShowFeedbackPrompt(true);
        }
      } else {
        downloadBlob(blob, filename);
        track('export_completed', { format, quality, action: 'download' });
        if (mountedRef.current) setShowFeedbackPrompt(true);
      }
    } catch (err) {
      console.error('Export failed:', err);
      if (mountedRef.current) {
        setExportError(
          err?.message === 'timeout'
            ? 'Export timed out after 60 seconds — please try again or use a different format.'
            : 'Export failed — please try again or use a different format.'
        );
      }
    } finally {
      clearTimeout(timeoutId);
      if (mountedRef.current) setDownloading(false);
    }
  }, [format, quality, buildExportOutput]);

  const handleShare = useCallback(async () => {
    try {
      const fullResOutput = await buildExportOutput();
      if (!fullResOutput) return;
      const mimeType = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
      const ext = format === 'jpeg' ? 'jpg' : format;
      const blob = await canvasToBlob(fullResOutput, mimeType, quality / 100);
      const filename = generateExportFilename(ext);
      if (isNativeApp()) {
        const { shared } = await shareNativeFile(blob, filename, mimeType);
        if (shared) {
          track('export_completed', { format, quality, action: 'share' });
          if (mountedRef.current) setShowFeedbackPrompt(true);
        }
        return;
      }
      if (!navigator.share || !navigator.canShare) return;
      const file = new File([blob], filename, { type: mimeType });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        track('export_completed', { format, quality, action: 'share' });
        if (mountedRef.current) setShowFeedbackPrompt(true);
      }
    } catch {
      // User cancelled share or share API failed
    }
  }, [format, quality, buildExportOutput]);

  const handleFeedbackDone = useCallback(() => {
    setShowFeedbackPrompt(false);
    reset();
  }, [reset]);

  const formatSize = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Export is at the working/tier resolution (see buildExportOutput), so the
  // dims label should match outputCanvasRef — not fullResCanvasRef, which is
  // the untouched source and no longer what gets written.
  const dims = outputCanvasRef.current
    ? `${outputCanvasRef.current.width}x${outputCanvasRef.current.height}`
    : '';

  const toolbarContent = (
    <div className="export-toolbar">
      <div className="export-format">
        <span className="export-format-label">Format</span>
        <div className="export-format-buttons">
          {['jpeg', 'png', 'webp'].map(f => (
            <button
              key={f}
              type="button"
              className={`export-format-btn${format === f ? ' is-active' : ''}`}
              onClick={() => setFormat(f)}
            >
              {f === 'jpeg' ? 'JPEG' : f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {format === 'jpeg' && (
        <div className="export-quality">
          <div className="export-quality-row">
            <span className="export-quality-label">Quality</span>
            <span className="export-quality-value">{quality}%</span>
          </div>
          <input
            type="range"
            className="export-quality-slider"
            min="10"
            max="100"
            value={quality}
            onChange={(e) => setQuality(parseInt(e.target.value, 10))}
            aria-label="JPEG quality"
          />
        </div>
      )}

      {fileSize && (
        <div className="export-file-info">{dims} · {formatSize(fileSize)}</div>
      )}

      {exportError && <div className="export-error-msg" role="alert">{exportError}</div>}

      <div className="export-primary-row">
        <button
          ref={downloadBtnRef}
          type="button"
          className="export-save-btn"
          onClick={canShare ? handleShare : handleDownload}
          disabled={downloading}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
          </svg>
          {downloading ? 'Building…' : (canShare ? 'Save to photos' : 'Download')}
        </button>
      </div>
    </div>
  );

  return (
    <ScreenShell
      stepLabel="Export"
      backAction={() => setScreen('review')}
      backLabel="Review"
      toolbar={toolbarContent}
    >
      <div
        className="export-canvas-area"
        ref={canvasWrapRef}
        onTouchStart={zoomTouchStart}
        onTouchMove={zoomTouchMove}
        onTouchEnd={zoomTouchEnd}
      >
        <div
          className="export-zoom-wrapper"
          style={{ transform: getTransformStyle(), transformOrigin: 'center center' }}
        >
          {/* Tight frame sized to the canvas's natural pixel dimensions.
              The compare button inside anchors to the image corners so it
              always sits fully within the rendered image, regardless of
              how the zoom hook scales the frame to fit. */}
          <div className="export-canvas-frame">
            <canvas ref={previewRef} className="export-canvas-full" />
            <button
              className={`compare-floating-btn ${showOriginal ? 'active' : ''}`}
              onClick={() => setShowOriginal(v => !v)}
              onTouchStart={(e) => e.stopPropagation()}
              title={showOriginal ? 'Showing original' : 'Show original'}
              aria-label={showOriginal ? 'Showing original image — tap to show result' : 'Show original image'}
              aria-pressed={showOriginal}
            >
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2" y="4" width="7" height="16" rx="2" fill={showOriginal ? 'currentColor' : 'none'} />
                <line x1="12" y1="3" x2="12" y2="21" />
                <rect x="15" y="4" width="7" height="16" rx="2" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Post-action prompt */}
      {showFeedbackPrompt && (
        <FeedbackPrompt
          onEditAnother={() => { setShowFeedbackPrompt(false); reset(); }}
          onDismiss={() => setShowFeedbackPrompt(false)}
          onGiveFeedback={() => { setShowFeedbackPrompt(false); onFeedback(); }}
        />
      )}

      {coachMarks.isActive && COACH_STEPS[coachMarks.activeStep] && (
        <CoachMark
          {...COACH_STEPS[coachMarks.activeStep]}
          stepIndex={coachMarks.activeStep}
          totalSteps={coachMarks.totalSteps}
          screenKey="export"
          onNext={coachMarks.next}
          onDismiss={coachMarks.dismiss}
          onDismissAll={() => { suppressAllWalkthroughs(); coachMarks.dismiss(); }}
        />
      )}
    </ScreenShell>
  );
}
