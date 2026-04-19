import { useRef, useEffect, useState, useCallback } from 'react';
import { usePipeline } from '../context/PipelineContext';
import { useImagePipeline } from '../hooks/useImagePipeline';
import { canvasToBlob, downloadBlob, generateExportFilename } from '../utils/imageHelpers';
import { track } from '../utils/analytics';
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
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            Edit Another Photo
          </button>
          <div className="feedback-prompt-divider" />
          <p className="feedback-prompt-text" id="feedback-prompt-text">We&apos;re in beta — your feedback directly shapes what we build next.</p>
          <button className="btn btn-secondary" onClick={onGiveFeedback}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
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
  const [format, setFormat] = useState('png');
  const [quality, setQuality] = useState(92);
  const [showOriginal, setShowOriginal] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [fileSize, setFileSize] = useState(null);
  const [showFeedbackPrompt, setShowFeedbackPrompt] = useState(false);
  const [exportError, setExportError] = useState(null);

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
      downloadBlob(blob, filename);
      track('export_completed', { format, quality, action: 'download' });
      if (mountedRef.current) setShowFeedbackPrompt(true);
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
    if (!navigator.share || !navigator.canShare) return;
    try {
      const fullResOutput = await buildExportOutput();
      if (!fullResOutput) return;
      const mimeType = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
      const ext = format === 'jpeg' ? 'jpg' : format;
      const blob = await canvasToBlob(fullResOutput, mimeType, quality / 100);
      const file = new File([blob], generateExportFilename(ext), { type: mimeType });
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
    <div className="bottom-toolbar-inner">
      {/* Main controls group */}
      <div className="export-toolbar-group">
        <div className="toolbar-row">
          <div className="toolbar-group">
            <div className="format-toggle format-toggle-compact">
              {['png', 'jpeg', 'webp'].map(f => (
                <button
                  key={f}
                  className={`format-toggle-btn ${format === f ? 'active' : ''}`}
                  onClick={() => setFormat(f)}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div className={`toolbar-group ${format === 'png' ? 'quality-disabled' : ''}`}>
            <label className="toolbar-slider">
              <span>Quality{format === 'png' ? ' (N/A)' : ` ${quality}%`}</span>
              <input type="range" min="10" max="100" value={quality}
                disabled={format === 'png'}
                onChange={(e) => setQuality(parseInt(e.target.value))} />
            </label>
          </div>
          <span className="file-info-compact">{dims} &middot; {formatSize(fileSize)}</span>
        </div>
        {exportError && <div className="toolbar-row export-error-row"><span className="export-error-msg">{exportError}</span></div>}
        <div className="toolbar-row export-action-row">
          <button ref={downloadBtnRef} className="btn btn-primary export-action-btn" onClick={handleDownload} disabled={downloading}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {downloading ? 'Building...' : 'Download'}
          </button>
          {typeof navigator !== 'undefined' && navigator.share && (
            <button className="btn btn-secondary export-action-btn" onClick={handleShare}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
              </svg>
              Share
            </button>
          )}
        </div>
      </div>

      {/* Feedback group */}
      <div className="export-feedback-group">
        <button className="btn btn-secondary export-feedback-btn" onClick={onFeedback}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          Send Feedback
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
          <canvas ref={previewRef} className="export-canvas-full" />
        </div>
        <button
          className={`compare-floating-btn ${showOriginal ? 'active' : ''}`}
          onClick={() => setShowOriginal(v => !v)}
          onTouchStart={(e) => e.stopPropagation()}
          title={showOriginal ? 'Showing original' : 'Show original'}
          aria-label={showOriginal ? 'Showing original image — tap to show result' : 'Show original image'}
          aria-pressed={showOriginal}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2" y="4" width="7" height="16" rx="2" fill={showOriginal ? 'currentColor' : 'none'} />
            <line x1="12" y1="3" x2="12" y2="21" />
            <rect x="15" y="4" width="7" height="16" rx="2" />
          </svg>
        </button>
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
