import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useBatch } from '../context/BatchContext';
import { usePipeline } from '../context/PipelineContext';
import { useEntitlement } from '../context/EntitlementContext';
import { useFaceDetection } from '../hooks/useFaceDetection';
import { prepareImage, processBatchCombined, hasPaintedPixels, buildFaceMask, createThumbnail, canvasToBlobUrl } from '../utils/batchProcessor';
import { applyMaskedBlur, BAR_STYLES } from '../utils/blurEngine';
import ColorSpectrumPicker from './ColorSpectrumPicker';
import { track } from '../utils/analytics';
import { useCoachMarks, suppressAllWalkthroughs } from '../hooks/useCoachMarks';
import CoachMark from './CoachMark';
import ConfirmModal from './ConfirmModal';
import BatchProcessModal from './BatchProcessModal';
import RedeemCodeModal from './RedeemCodeModal';
import ScreenShell from './ScreenShell';
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
  const { premium, loading: entitlementLoading } = useEntitlement();
  const [showConfirmBack, setShowConfirmBack] = useState(false);
  const [showProcessModal, setShowProcessModal] = useState(false);
  const [showRedeem, setShowRedeem] = useState(false);
  const fileInputRef = useRef(null);
  const detectingRef = useRef(false);
  const processAbortRef = useRef(null);
  const batchGridRef = useRef(null);

  // Global Stickers dropdown (mirrors the editor selector, minus freehand).
  const [barStyleMenuOpen, setBarStyleMenuOpen] = useState(false);
  const [barStyleMenuPos, setBarStyleMenuPos] = useState(null);
  const [barColorPickerOpen, setBarColorPickerOpen] = useState(false);
  const barStyleMenuWrapRef = useRef(null);
  const barStyleTriggerRef = useRef(null);
  const barStyleMenuElRef = useRef(null);
  useEffect(() => {
    if (!barStyleMenuOpen) return;
    const onDown = (e) => {
      if (barStyleMenuWrapRef.current && !barStyleMenuWrapRef.current.contains(e.target)
          && (!barStyleMenuElRef.current || !barStyleMenuElRef.current.contains(e.target))) {
        setBarStyleMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [barStyleMenuOpen]);

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
      const wantBlur = mode === 'gaussian' || mode === 'pixelate';
      (async () => {
        for (let i = 0; i < eligible.length; i++) {
          const img = eligible[i];
          if (regenCancelRef.current) return;
          const w = img.strippedCanvas.width, h = img.strippedCanvas.height;
          const blurMask = wantBlur ? buildFaceMask(img.detections, w, h, mode, globalFeather) : null;
          // Grid thumbnails show the global blur only; stickers are placed
          // per-image in the editor, so no sticker objects here.
          const blurred = applyMaskedBlur(img.strippedCanvas, blurMask, wantBlur ? mode : 'none', strength, [], null, globalBlurSettings.barColor || '#000000');
          const thumbCanvas = createThumbnail(blurred);
          const thumbUrl = await canvasToBlobUrl(thumbCanvas);
          blurred.width = 0; blurred.height = 0;
          if (blurMask) { blurMask.width = 0; blurMask.height = 0; }
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
          // Yield to the event loop between thumbnails so the browser can
          // paint the new thumbnail before we start the next blur. Without
          // this, several thumbnails get computed and committed in the same
          // task, producing a "pop-pop-pop" burst instead of a smooth one-
          // by-one fill. Only yield between thumbnails (not after the last).
          if (i < eligible.length - 1) {
            await new Promise((r) => setTimeout(r, 0));
          }
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

  // Track once per visit when a non-premium user lands on the gated batch
  // screen — same `subscription_gated` signal we used to fire on Subscribe
  // clicks back when subscribe was a button on this gate.
  useEffect(() => {
    if (!premium && !entitlementLoading) {
      track('subscription_gated', { surface: 'batch' });
    }
  }, [premium, entitlementLoading]);

  const allDetected = images.length > 0 && images.every(img =>
    img.status === 'ready' || img.status === 'no-faces' || img.status === 'edited' || img.status === 'done' || img.status === 'error'
  );
  // Signal to the primary-button label that clicking will redo work already
  // done — covers both the "returned-from-export" accidental-tap case and
  // the intentional "changed settings / edited a card" re-run case.
  const anyDone = images.some(img => img.status === 'done');

  // Only one coach step so far — the per-image tap-to-edit tip that used
  // to live as persistent hint text above the grid. `skip` makes sure it
  // doesn't fire until the user actually has something to tap on.
  const COACH_STEPS = [
    { targetRef: batchGridRef, position: 'bottom', title: 'Fine-tune per image', body: 'Tap any photo to adjust its blur regions before processing.' },
  ];
  const coachMarks = useCoachMarks('batchGrid', COACH_STEPS.length, {
    skip: !allDetected || images.length === 0,
  });

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

  // Batch processing is a paid feature. Free users hit an upgrade CTA
  // instead of the grid. We still render the standard header so the back
  // button works. `entitlementLoading` gates the gate itself — we wait for
  // the first entitlement check to resolve before deciding which view to
  // show, so a subscribed user reloading the page doesn't flash the CTA.
  if (!premium && !entitlementLoading) {
    return (
      <>
        <ScreenShell
          backAction={onBack}
          backLabel="Back"
          stepLabel="Batch Protect"
          topRight={images.length > 0 ? <span className="top-bar-count">{images.length}/20</span> : null}
        >
          <div className="batch-upgrade-gate">
            <h3>Batch processing is a Protect+ feature</h3>
            <p>Redeem a promo code for free access to batch processing, unlimited tattoo removal, and an ad-free experience.</p>
            <div className="batch-upgrade-actions">
              <button className="btn btn-primary btn-lg" onClick={() => setShowRedeem(true)}>
                Redeem a promo code
              </button>
            </div>
          </div>
        </ScreenShell>
        {showRedeem && (
          <RedeemCodeModal
            onClose={() => setShowRedeem(false)}
            onSuccess={() => setShowRedeem(false)}
          />
        )}
      </>
    );
  }

  const gStickerOn = !!globalBlurSettings.stickerEnabled;
  const gWantBlur = globalBlurSettings.mode === 'gaussian' || globalBlurSettings.mode === 'pixelate';
  const gActiveBarStyle = BAR_STYLES.find((s) => s.key === (globalBlurSettings.barStyle || 'solid')) || BAR_STYLES[0];

  const toolbarContent = (
    <>
      <div className="batch-controls">
        <div className="batch-mode-toggle">
          {[{ value: 'gaussian', label: 'Gaussian' }, { value: 'pixelate', label: 'Pixelate' }].map(opt => (
            <button
              key={opt.value}
              className={`batch-mode-btn ${globalBlurSettings.mode === opt.value ? 'active' : ''}`}
              onClick={() => setGlobalBlurSettings(prev => ({ ...prev, mode: prev.mode === opt.value ? 'none' : opt.value }))}
            >
              {opt.label}
            </button>
          ))}
          <div className="bar-style-menu-wrap" ref={barStyleMenuWrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
            <button
              ref={barStyleTriggerRef}
              className={`batch-mode-btn ${gStickerOn ? 'active' : ''}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              aria-haspopup="menu"
              aria-expanded={barStyleMenuOpen}
              aria-pressed={gStickerOn}
              onClick={() => {
                setBarStyleMenuOpen(v => {
                  const next = !v;
                  if (next && barStyleTriggerRef.current) {
                    const r = barStyleTriggerRef.current.getBoundingClientRect();
                    setBarStyleMenuPos({ left: r.left, bottom: window.innerHeight - r.top + 4 });
                  }
                  return next;
                });
              }}
            >
              <span>{gStickerOn ? gActiveBarStyle.label : 'Stickers'}</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {barStyleMenuOpen && barStyleMenuPos && createPortal(
              <div
                ref={barStyleMenuElRef}
                className="bar-style-menu"
                role="menu"
                aria-label="Stickers"
                style={{ left: barStyleMenuPos.left, bottom: barStyleMenuPos.bottom }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="bar-style-menu-item bar-style-menu-color"
                  onClick={() => { setBarStyleMenuOpen(false); setBarColorPickerOpen(true); }}
                >
                  <span className="bar-style-menu-swatch" style={{ background: globalBlurSettings.barColor || '#000000' }} aria-hidden="true" />
                  <span>Color…</span>
                </button>
                <div className="bar-style-menu-divider" role="separator" />
                {BAR_STYLES.map((s) => {
                  const sel = gStickerOn && (globalBlurSettings.barStyle || 'solid') === s.key;
                  return (
                    <button
                      key={s.key}
                      type="button"
                      role="menuitemradio"
                      aria-checked={sel}
                      className={`bar-style-menu-item${sel ? ' is-active' : ''}`}
                      onClick={() => {
                        setGlobalBlurSettings(prev => ({ ...prev, stickerEnabled: true, barStyle: s.key }));
                        setBarStyleMenuOpen(false);
                      }}
                    >
                      {s.label}
                    </button>
                  );
                })}
                {gStickerOn && (
                  <>
                    <div className="bar-style-menu-divider" role="separator" />
                    <button
                      type="button"
                      role="menuitem"
                      className="bar-style-menu-item bar-style-menu-off"
                      onClick={() => { setGlobalBlurSettings(prev => ({ ...prev, stickerEnabled: false })); setBarStyleMenuOpen(false); }}
                    >
                      Turn off stickers
                    </button>
                  </>
                )}
              </div>,
              document.body
            )}
          </div>
        </div>
        <div className="batch-slider-group">
          {gWantBlur && (
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
          {gStickerOn && (
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
            <span className="batch-progress-text">{processedCount}/{images.length}</span>
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
    </>
  );

  return (
    <>
      <ScreenShell
        backAction={handleBack}
        backLabel="Back"
        stepLabel="Batch Protect"
        topRight={<span className="top-bar-count">{images.length}/20</span>}
        toolbar={toolbarContent}
      >
      {metadataSummary && (
        <p className="batch-metadata-summary" role="status">{metadataSummary}</p>
      )}

      <div className="batch-grid" ref={batchGridRef}>
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
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
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
            <span className="batch-card-add-inner">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>Add More</span>
            </span>
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

      </ScreenShell>

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

      {coachMarks.isActive && COACH_STEPS[coachMarks.activeStep] && (
        <CoachMark
          {...COACH_STEPS[coachMarks.activeStep]}
          stepIndex={coachMarks.activeStep}
          totalSteps={coachMarks.totalSteps}
          screenKey="batchGrid"
          onNext={coachMarks.next}
          onDismiss={coachMarks.dismiss}
          onDismissAll={() => { suppressAllWalkthroughs(); coachMarks.dismiss(); }}
        />
      )}

      <ColorSpectrumPicker
        open={barColorPickerOpen}
        value={globalBlurSettings.barColor || '#000000'}
        onChange={(hex) => setGlobalBlurSettings(prev => ({ ...prev, stickerEnabled: true, barColor: hex }))}
        onClose={() => setBarColorPickerOpen(false)}
        ariaLabel="Sticker color"
      />
    </>
  );
}
