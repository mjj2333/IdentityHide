import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useBatch } from '../context/BatchContext';
import { usePipeline } from '../context/PipelineContext';
import { useFaceDetection } from '../hooks/useFaceDetection';
import { prepareImage, processBatchCombined, hasPaintedPixels, buildFaceMask, createThumbnail, canvasToBlobUrl } from '../utils/batchProcessor';
import { applyMaskedBlur, BLUR_MODES } from '../utils/blurEngine';
import { track } from '../utils/analytics';
import ConfirmModal from './ConfirmModal';
import BatchProcessModal from './BatchProcessModal';
import '../styles/BatchGrid.css';

function makeId() {
  try { return crypto.randomUUID(); } catch {}
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function BatchGridScreen({ onBack, onExport, onEditImage }) {
  const {
    images, setImages, addImages, removeImage, updateImage,
    globalBlurSettings, setGlobalBlurSettings,
    globalFeather, setGlobalFeather,
    activeImageId, setActiveImageId,
    batchStatus, setBatchStatus,
    processedCount, setProcessedCount,
    currentImageLabel, setCurrentImageLabel,
  } = useBatch();

  const { detect } = useFaceDetection();
  const { setWarning, selectedTierMP } = usePipeline();
  const [showConfirmBack, setShowConfirmBack] = useState(false);
  const [showProcessModal, setShowProcessModal] = useState(false);
  const fileInputRef = useRef(null);
  const detectingRef = useRef(false);
  const processAbortRef = useRef(null);

  // Run face detection on any image that needs it.
  // Stores the unblurred thumbnail — the blur-preview regen effect below
  // applies settings uniformly once the image reaches 'ready' status.
  // This avoids inconsistent previews when settings change mid-detection.
  useEffect(() => {
    if (detectingRef.current) return;
    const pending = images.filter(img => img.status === 'pending');
    if (pending.length === 0) return;

    detectingRef.current = true;
    setBatchStatus('detecting');

    (async () => {
      for (const img of pending) {
        updateImage(img.id, { status: 'detecting' });
        try {
          const { strippedCanvas, thumbnailCanvas, thumbnailUrl, exifSummary } = await prepareImage(img.file, selectedTierMP);
          const detections = await detect(strippedCanvas);
          updateImage(img.id, {
            status: detections.length > 0 ? 'ready' : 'no-faces',
            strippedCanvas,
            thumbnailCanvas,
            thumbnailUrl,
            detections,
            exifSummary,
          });
        } catch (err) {
          console.warn('[Batch] Detection failed for', img.file.name, err);
          updateImage(img.id, { status: 'error', error: err.message });
        }
      }
      detectingRef.current = false;
      setBatchStatus('ready');
    })();
  }, [images, detect, updateImage, setBatchStatus, selectedTierMP]);

  // Regenerate blurred preview thumbnails when settings change or new
  // images reach 'ready' status (detection loop stores unblurred thumbs).
  // Debounced (150ms) so slider scrubbing doesn't freeze the UI with 10+ images.
  // Stamps each image with the settings used so it only re-blurs when needed.
  // A cancelled ref lets a new run abort a stale one mid-loop.
  const settingsKey = JSON.stringify([globalBlurSettings, globalFeather]);
  const regenCancelRef = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      const eligible = images.filter(img =>
        img.status === 'ready' && img.strippedCanvas && img.detections?.length > 0
        && img._blurKey !== settingsKey
      );
      if (eligible.length === 0) return;

      regenCancelRef.current = false;
      const { mode, strength } = globalBlurSettings;
      const barSettings = mode === 'blackbar' ? { width: globalBlurSettings.barWidth ?? 20, length: globalBlurSettings.barLength ?? 110, angle: globalBlurSettings.barAngle ?? 0 } : null;
      (async () => {
        for (const img of eligible) {
          if (regenCancelRef.current) return;
          const mask = buildFaceMask(img.detections, img.strippedCanvas.width, img.strippedCanvas.height, mode, globalFeather);
          const blurred = applyMaskedBlur(img.strippedCanvas, mask, mode, strength, img.detections, barSettings);
          const thumbCanvas = createThumbnail(blurred);
          const thumbUrl = await canvasToBlobUrl(thumbCanvas);
          blurred.width = 0; blurred.height = 0;
          mask.width = 0; mask.height = 0;
          if (regenCancelRef.current) {
            // Cancel tripped during canvasToBlobUrl — release what we just
            // allocated. Also: we haven't revoked the old img.thumbnailUrl
            // yet, so state still shows a valid URL until the next regen
            // run (vs. a broken-image flash if we had revoked eagerly).
            URL.revokeObjectURL(thumbUrl);
            thumbCanvas.width = 0; thumbCanvas.height = 0;
            return;
          }
          // Committed — swap in the new thumbnail and revoke the old URL.
          if (img.thumbnailUrl) URL.revokeObjectURL(img.thumbnailUrl);
          updateImage(img.id, { thumbnailCanvas: thumbCanvas, thumbnailUrl: thumbUrl, _blurKey: settingsKey });
        }
      })();
    }, 150);
    return () => {
      clearTimeout(timer);
      regenCancelRef.current = true;
    };
  }, [images, settingsKey]);

  const handleAddMore = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelect = useCallback((e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;

    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
    const remaining = 20 - images.length;
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    const oversized = imageFiles.filter(f => f.size > MAX_FILE_SIZE);
    const validFiles = imageFiles.filter(f => f.size <= MAX_FILE_SIZE);
    const toAdd = validFiles.slice(0, remaining);

    const warnings = [];
    if (oversized.length > 0) {
      warnings.push(`${oversized.length} file${oversized.length > 1 ? 's' : ''} over 50 MB skipped`);
    }
    if (validFiles.length > remaining) {
      warnings.push(`max 20 images — added ${toAdd.length}, skipped ${validFiles.length - remaining}`);
    }
    if (warnings.length > 0) {
      setWarning(warnings.join('. ') + '.');
    }

    const entries = toAdd.map(file => ({
      id: makeId(),
      file,
      status: 'pending',
      detections: [],
      editDetections: null,
      blurSettings: null,
      strippedCanvas: null,
      thumbnailCanvas: null,
      outputCanvas: null,
      tattooMaskCanvas: null,
      error: null,
    }));

    addImages(entries);
    track('batch_images_added', { count: entries.length, total: images.length + entries.length });
  }, [images.length, addImages, setWarning]);

  const handleRemove = useCallback((e, id) => {
    e.stopPropagation();
    removeImage(id);
  }, [removeImage]);

  const handleThumbnailClick = useCallback((id) => {
    const img = images.find(i => i.id === id);
    if (!img || !img.strippedCanvas) return;
    setActiveImageId(id);
    onEditImage(id);
  }, [images, setActiveImageId, onEditImage]);

  const handleCardKeyDown = useCallback((e, id) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeImage(id);
    } else if (e.key === 'Enter' || e.key === ' ') {
      // Native <button> fires click on Enter+Space for free. Role="button"
      // on a <div> doesn't — we translate explicitly. handleThumbnailClick
      // already no-ops when strippedCanvas is absent, so the aria-disabled
      // "no activation" contract is preserved.
      e.preventDefault();
      handleThumbnailClick(id);
    }
  }, [removeImage, handleThumbnailClick]);

  const allDetected = images.length > 0 && images.every(img =>
    img.status === 'ready' || img.status === 'no-faces' || img.status === 'edited' || img.status === 'done' || img.status === 'error'
  );
  // Signal to the primary-button label that clicking will redo work already
  // done — covers both the "returned-from-export" accidental-tap case and
  // the intentional "changed settings / edited a card" re-run case.
  const anyDone = images.some(img => img.status === 'done');

  // Parity with ReviewScreen's metadata summary in the single-image flow.
  // Canvas re-encode always strips EXIF; the interesting signal for users
  // is whether any image leaked location data — so we surface that count
  // while stating the blanket promise that everything is removed.
  const metadataSummary = useMemo(() => {
    const analyzed = images.filter(img => img.exifSummary);
    if (analyzed.length === 0) return null;
    const locCount = analyzed.filter(img => img.exifSummary?.hadLocation).length;
    if (locCount === 0) return 'All metadata stripped';
    return `All metadata stripped · location detected in ${locCount} photo${locCount !== 1 ? 's' : ''}`;
  }, [images]);

  // Kick off batch processing at the chosen tier. Called either directly
  // (face-only batches, no modal) or by BatchProcessModal on confirm.
  const startProcessing = useCallback(async (tierMP) => {
    // Re-entrancy guard — a fast double-tap (or programmatic double-click
    // from a11y tools / iOS touch ghosting) can dispatch a second click
    // before React commits the `batchStatus='processing'` render that swaps
    // this button for the Cancel button. Without this check, the second
    // call would spawn a second AbortController and leak the first one.
    if (processAbortRef.current) return;

    setBatchStatus('processing');
    setProcessedCount(0);
    setCurrentImageLabel(null);
    const tattooCount = images.filter(img => hasPaintedPixels(img.tattooMaskCanvas)).length;
    track('batch_process_start', { count: images.length, tattooCount, tierMP: tierMP === Infinity ? 'original' : tierMP });

    const controller = new AbortController();
    processAbortRef.current = controller;

    try {
      await processBatchCombined(
        images,
        globalBlurSettings,
        globalFeather,
        tierMP,
        (completed, total, detail) => {
          // Map stages to user-facing labels. Inpainting dominates perceived
          // latency, so its per-step progress gets surfaced verbatim.
          if (detail.stage === 'inpainting') {
            const pct = Math.round((detail.stageFraction || 0) * 100);
            setCurrentImageLabel(`Image ${completed + 1}/${total} · ${detail.message || 'Inpainting'} ${pct}%`);
          } else if (detail.stage === 'blurring') {
            setCurrentImageLabel(`Image ${completed + 1}/${total} · Blurring faces`);
          } else if (detail.stage === 'done' || detail.stage === 'skipped') {
            setProcessedCount(completed);
            if (detail.error) {
              updateImage(detail.id, { status: 'error', error: detail.error });
            } else if (detail.outputCanvas) {
              // Commit status + output immediately so the card flips to Done
              // without waiting for the async thumbnail regen below.
              updateImage(detail.id, { status: 'done', outputCanvas: detail.outputCanvas });
              // Regen thumbnail from the processed output so both the grid and
              // the export screen show the actual result (tattoos removed + faces
              // blurred) — the pre-process thumbnail would otherwise mislead the
              // user into thinking nothing happened.
              const thumbCanvas = createThumbnail(detail.outputCanvas);
              canvasToBlobUrl(thumbCanvas).then(thumbUrl => {
                setImages(prev => {
                  const idx = prev.findIndex(im => im.id === detail.id);
                  if (idx === -1) {
                    // Image removed mid-processing — release what we just allocated.
                    URL.revokeObjectURL(thumbUrl);
                    thumbCanvas.width = 0; thumbCanvas.height = 0;
                    return prev;
                  }
                  const oldUrl = prev[idx].thumbnailUrl;
                  if (oldUrl && oldUrl !== thumbUrl) URL.revokeObjectURL(oldUrl);
                  const next = [...prev];
                  next[idx] = { ...next[idx], thumbnailCanvas: thumbCanvas, thumbnailUrl: thumbUrl };
                  return next;
                });
              });
            }
          }
        },
        controller.signal,
      );

      setBatchStatus('done');
      setCurrentImageLabel(null);
      track('batch_process_complete', { count: images.length });
      onExport();
    } catch (err) {
      if (err.name === 'AbortError') {
        // User cancelled — images completed before the cancel keep their
        // 'done' status (committed incrementally inside the onProgress
        // callback above). Remaining images stay in their pre-batch state.
        setBatchStatus('ready');
        setProcessedCount(0);
        setCurrentImageLabel(null);
      } else {
        console.error('[Batch] Processing failed:', err);
        setBatchStatus('ready');
        setCurrentImageLabel(null);
        setWarning({ message: 'Batch processing failed. Please try again.', sticky: true });
      }
    } finally {
      processAbortRef.current = null;
    }
  }, [images, globalBlurSettings, globalFeather, setBatchStatus, setProcessedCount, setCurrentImageLabel, updateImage, setImages, onExport, setWarning]);

  const handleProcessAll = useCallback(() => {
    if (processAbortRef.current) return;
    // Only pop the modal when at least one image has a tattoo mask — face-only
    // batches are fast enough that a confirm dialog would just be friction.
    const anyTattoo = images.some(img => hasPaintedPixels(img.tattooMaskCanvas));
    if (anyTattoo) {
      setShowProcessModal(true);
    } else {
      // Face-only: tier doesn't matter (no ComfyUI calls). Pass 1 as a safe default.
      startProcessing(1);
    }
  }, [images, startProcessing]);

  const handleCancelProcessing = useCallback(() => {
    processAbortRef.current?.abort();
  }, []);

  const handleBack = useCallback(() => {
    if (images.length > 0) {
      setShowConfirmBack(true);
    } else {
      onBack();
    }
  }, [images.length, onBack]);

  const statusBadge = (img) => {
    switch (img.status) {
      case 'pending':
      case 'detecting':
        return <span className="batch-badge batch-badge-grey">Detecting...</span>;
      case 'ready':
        return <span className="batch-badge batch-badge-blue">{img.detections.length} {img.detections.length === 1 ? 'face' : 'faces'}</span>;
      case 'no-faces':
        return <span className="batch-badge batch-badge-dim">No faces</span>;
      case 'edited':
        return <span className="batch-badge batch-badge-purple">Edited</span>;
      case 'done':
        return <span className="batch-badge batch-badge-green">Done</span>;
      case 'error':
        return <span className="batch-badge batch-badge-red" title={img.error || 'Unknown error'}>Error</span>;
      default:
        return null;
    }
  };

  return (
    <div className="batch-screen">
      <header className="batch-header">
        <button className="btn btn-ghost" onClick={handleBack}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </button>
        <h2 className="batch-title">Batch Protect</h2>
        <span className="batch-count">{images.length}/20 photos</span>
      </header>

      {allDetected && images.length > 0 && (
        <p className="batch-hint">Tap any photo to adjust its blur regions</p>
      )}

      {metadataSummary && (
        <p className="batch-metadata-summary" role="status">{metadataSummary}</p>
      )}

      <div className="batch-grid">
        {images.map(img => (
          // Using <div role="button"> instead of <button> so the remove-× can
          // live inside without producing nested interactive elements — the
          // HTML spec forbids <button> descendants of <button>, and Safari +
          // some screen readers flatten the nesting in unpredictable ways.
          // Keyboard activation (Enter/Space) is handled in handleCardKeyDown.
          <div
            key={img.id}
            className={`batch-card ${img.status === 'detecting' ? 'batch-card-loading' : ''}`}
            role="button"
            tabIndex={img.strippedCanvas ? 0 : -1}
            aria-disabled={img.strippedCanvas ? undefined : true}
            onClick={() => handleThumbnailClick(img.id)}
            onKeyDown={(e) => handleCardKeyDown(e, img.id)}
            aria-label={`${img.file.name} — press Delete to remove`}
          >
            <button
              className="batch-card-remove"
              onClick={(e) => handleRemove(e, img.id)}
              aria-label={`Remove ${img.file.name}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            {img.exifSummary?.hadLocation && (
              <div
                className="batch-card-location"
                aria-label="Location metadata stripped from this photo"
                title="Location metadata stripped"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z" />
                </svg>
              </div>
            )}
            {img.strippedCanvas && (
              <div className="batch-card-edit-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </div>
            )}
            {img.thumbnailUrl ? (
              <img
                className="batch-card-thumb"
                src={img.thumbnailUrl}
                alt={img.file.name}
              />
            ) : (
              <div className="batch-card-placeholder">
                <div className="batch-card-spinner" />
              </div>
            )}
            <div className="batch-card-info">
              {statusBadge(img)}
            </div>
          </div>
        ))}

        {images.length < 20 && (
          <button className="batch-card batch-card-add" onClick={handleAddMore}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>Add More</span>
          </button>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleFileSelect}
        className="dropzone-input"
        aria-label="Add more images"
      />

      <div className="batch-bottom">
        <div className="batch-controls">
          <div className="batch-mode-toggle">
            {BLUR_MODES.map(m => (
              <button
                key={m.key}
                className={`batch-mode-btn ${globalBlurSettings.mode === m.key ? 'active' : ''}`}
                onClick={() => setGlobalBlurSettings(prev => ({ ...prev, mode: m.key }))}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="batch-slider-group">
            {globalBlurSettings.mode === 'blackbar' ? (
              <>
                <label className="batch-slider-label">
                  Width
                  <input
                    type="range"
                    min="5"
                    max="80"
                    value={globalBlurSettings.barWidth}
                    onChange={(e) => setGlobalBlurSettings(prev => ({ ...prev, barWidth: Number(e.target.value) }))}
                    className="batch-slider"
                  />
                  <span className="batch-slider-value">{globalBlurSettings.barWidth}</span>
                </label>
                <label className="batch-slider-label">
                  Length
                  <input
                    type="range"
                    min="50"
                    max="200"
                    value={globalBlurSettings.barLength}
                    onChange={(e) => setGlobalBlurSettings(prev => ({ ...prev, barLength: Number(e.target.value) }))}
                    className="batch-slider"
                  />
                  <span className="batch-slider-value">{globalBlurSettings.barLength}</span>
                </label>
                <label className="batch-slider-label">
                  Angle
                  <input
                    type="range"
                    min="-45"
                    max="45"
                    value={globalBlurSettings.barAngle}
                    onChange={(e) => setGlobalBlurSettings(prev => ({ ...prev, barAngle: Number(e.target.value) }))}
                    className="batch-slider"
                  />
                  <span className="batch-slider-value">{globalBlurSettings.barAngle}&deg;</span>
                </label>
              </>
            ) : (
              <>
                <label className="batch-slider-label">
                  Strength
                  <input
                    type="range"
                    min="5"
                    max="60"
                    value={globalBlurSettings.strength}
                    onChange={(e) => setGlobalBlurSettings(prev => ({ ...prev, strength: Number(e.target.value) }))}
                    className="batch-slider"
                  />
                  <span className="batch-slider-value">{globalBlurSettings.strength}</span>
                </label>
                <label className="batch-slider-label">
                  Feather
                  <input
                    type="range"
                    min="0"
                    max="60"
                    value={globalFeather}
                    onChange={(e) => setGlobalFeather(Number(e.target.value))}
                    className="batch-slider"
                  />
                  <span className="batch-slider-value">{globalFeather}</span>
                </label>
              </>
            )}
          </div>
        </div>

        <div className="batch-actions">
          {batchStatus === 'processing' && (
            <div className="batch-progress" role="status" aria-live="polite">
              <div className="batch-progress-bar">
                <div
                  className="batch-progress-fill"
                  style={{ width: `${(processedCount / images.length) * 100}%` }}
                />
              </div>
              <span className="batch-progress-text">{processedCount}/{images.length} processed</span>
              {currentImageLabel && (
                <span className="batch-progress-substep">{currentImageLabel}</span>
              )}
            </div>
          )}
          {batchStatus === 'processing' ? (
            <button
              className="btn btn-ghost btn-lg"
              onClick={handleCancelProcessing}
            >
              Cancel ({processedCount}/{images.length})
            </button>
          ) : (
            <button
              className="btn btn-primary btn-lg"
              onClick={handleProcessAll}
              disabled={!allDetected || images.length === 0}
            >
              {anyDone ? 'Re-process All' : 'Process All'} ({images.length})
            </button>
          )}
        </div>
      </div>

      {showConfirmBack && (
        <ConfirmModal
          title="Discard batch?"
          message={`You have ${images.length} image${images.length > 1 ? 's' : ''} loaded. Going back will discard them.`}
          confirmLabel="Discard"
          onConfirm={() => { setShowConfirmBack(false); onBack(); }}
          onCancel={() => setShowConfirmBack(false)}
        />
      )}

      {showProcessModal && (
        <BatchProcessModal
          images={images}
          defaultTierMP={selectedTierMP}
          onConfirm={(tierMP) => {
            setShowProcessModal(false);
            startProcessing(tierMP);
          }}
          onCancel={() => setShowProcessModal(false)}
        />
      )}
    </div>
  );
}
