import { useState, useCallback, useMemo } from 'react';
import { useBatch } from '../context/BatchContext';
import { usePipeline } from '../context/PipelineContext';
import { buildBatchZip, applyBatchBlur, hasPaintedPixels, prepareImage } from '../utils/batchProcessor';
import { canvasToBlob, downloadBlob } from '../utils/imageHelpers';
import { track } from '../utils/analytics';
import { isNativeApp } from '../utils/platform';
import { shareNativeFile } from '../utils/nativeMedia';
import ScreenShell from './ScreenShell';

const FORMATS = [
  { key: 'png', label: 'PNG', mime: 'image/png' },
  { key: 'jpg', label: 'JPEG', mime: 'image/jpeg' },
  { key: 'webp', label: 'WebP', mime: 'image/webp' },
];

export default function BatchExportScreen({ onDone, onBack }) {
  const { images, resetBatch, globalBlurSettings, globalFeather, updateImage } = useBatch();
  const { selectedTierMP } = usePipeline();
  const [format, setFormat] = useState('png');
  const [quality, setQuality] = useState(92);
  const [downloading, setDownloading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [downloadingId, setDownloadingId] = useState(null);

  const doneImages = images.filter(img => img.status === 'done' || img.status === 'edited' || img.outputCanvas);
  const facesBlurred = images.filter(img => (img.detections?.length || 0) > 0).length;
  const tattoosRemoved = images.filter(img => hasPaintedPixels(img.tattooMaskCanvas)).length;

  // Returns the image's outputCanvas, generating it lazily for 'edited' images
  // that reached this screen without going through processBatchFaceBlur.
  // Result is cached onto the image via updateImage so repeat exports reuse it.
  // Returns null only if the image has no source canvas to work from — callers
  // must skip (never fall back to strippedCanvas, which would export unblurred).
  const ensureOutputCanvas = useCallback(async (img) => {
    if (img.outputCanvas) return img.outputCanvas;
    // The full canvas isn't retained (iOS memory). Re-derive it from the file
    // when needed, normalized to the dims the saved edits/detections were built
    // at, then free the temporary copy.
    let stripped = img.strippedCanvas;
    let derived = false;
    if (!stripped) {
      if (!img.file) return null;
      try {
        ({ strippedCanvas: stripped } = await prepareImage(img.file, selectedTierMP));
        derived = true;
        if (img.srcW && img.srcH && (stripped.width !== img.srcW || stripped.height !== img.srcH)) {
          const fit = document.createElement('canvas');
          fit.width = img.srcW; fit.height = img.srcH;
          const fctx = fit.getContext('2d');
          fctx.imageSmoothingEnabled = true; fctx.imageSmoothingQuality = 'high';
          fctx.drawImage(stripped, 0, 0, img.srcW, img.srcH);
          stripped.width = 0; stripped.height = 0;
          stripped = fit;
        }
      } catch { return null; }
    }
    const entry = stripped === img.strippedCanvas ? img : { ...img, strippedCanvas: stripped };
    const canvas = applyBatchBlur(entry, globalBlurSettings, globalFeather);
    if (derived) { stripped.width = 0; stripped.height = 0; }
    updateImage(img.id, { outputCanvas: canvas, status: 'done' });
    return canvas;
  }, [globalBlurSettings, globalFeather, updateImage, selectedTierMP]);

  const isIOS = useMemo(() => /iPad|iPhone|iPod/.test(navigator.userAgent), []);
  const isNative = isNativeApp();

  const canShare = useMemo(() => {
    if (isNative) return true; // Native shells always have a share sheet
    if (!isIOS) return false; // iOS Safari is the only web target with "Save to Photos"
    if (typeof navigator === 'undefined' || !navigator.share || !navigator.canShare) return false;
    try {
      const testFile = new File(['test'], 'test.png', { type: 'image/png' });
      return navigator.canShare({ files: [testFile] });
    } catch {
      return false;
    }
  }, [isIOS, isNative]);

  // Multi-image "save all" flow.
  //   - Web (iOS Safari): Web Share API with multiple File objects. iOS Photos
  //     accepts the whole batch in one share sheet.
  //   - Native: loop through images, opening the OS share sheet once per
  //     image. Capacitor's @capacitor/share takes a single URL, so a batched
  //     share isn't possible — but landing each image in Photos individually
  //     is the right semantic for "Save N to Photos".
  const handleShareAll = useCallback(async () => {
    if (!canShare || doneImages.length === 0) return;
    setSharing(true);
    track('batch_export_share', { count: doneImages.length, format });

    try {
      const mime = FORMATS.find(f => f.key === format)?.mime || 'image/png';
      const ext = format === 'jpg' ? 'jpg' : format;

      if (isNative) {
        for (const img of doneImages) {
          const canvas = await ensureOutputCanvas(img);
          if (!canvas) continue;
          const blob = await canvasToBlob(canvas, mime, quality / 100);
          const stem = img.file?.name?.replace(/\.[^.]+$/, '') || 'image';
          const filename = `${stem}_protected.${ext}`;
          // If the user cancels mid-loop, abort the rest — they're done.
          const { shared } = await shareNativeFile(blob, filename, mime);
          if (!shared) break;
        }
        return;
      }

      const files = [];
      for (const img of doneImages) {
        const canvas = await ensureOutputCanvas(img);
        if (!canvas) continue;
        const blob = await canvasToBlob(canvas, mime, quality / 100);
        const stem = img.file?.name?.replace(/\.[^.]+$/, '') || 'image';
        files.push(new File([blob], `${stem}_protected.${ext}`, { type: mime }));
      }

      if (files.length > 0 && navigator.canShare({ files })) {
        await navigator.share({ files });
      }
    } catch (err) {
      // User cancelled or share failed — that's ok
      if (err.name !== 'AbortError') {
        console.warn('[BatchExport] Share failed:', err);
      }
    } finally {
      setSharing(false);
    }
  }, [canShare, doneImages, format, quality, ensureOutputCanvas, isNative]);

  // Download each file individually — on Android they go to Downloads and appear in Gallery
  const [downloadProgress, setDownloadProgress] = useState(null);
  const handleDownloadIndividual = useCallback(async () => {
    if (doneImages.length === 0) return;
    setDownloading(true);
    setDownloadProgress({ done: 0, total: doneImages.length });
    track('batch_export_individual', { count: doneImages.length, format });
    const mime = FORMATS.find(f => f.key === format)?.mime || 'image/png';
    const ext = format === 'jpg' ? 'jpg' : format;

    for (let i = 0; i < doneImages.length; i++) {
      const img = doneImages[i];
      const canvas = await ensureOutputCanvas(img);
      if (!canvas) continue;
      try {
        const blob = await canvasToBlob(canvas, mime, quality / 100);
        const stem = img.file?.name?.replace(/\.[^.]+$/, '') || `image_${i + 1}`;
        downloadBlob(blob, `${stem}_protected.${ext}`);
        setDownloadProgress({ done: i + 1, total: doneImages.length });
        // Small delay between downloads to avoid browser throttling
        if (i < doneImages.length - 1) await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        console.warn('[BatchExport] Download failed for', img.file?.name, err);
      }
    }
    setDownloading(false);
    setDownloadProgress(null);
  }, [doneImages, format, quality, ensureOutputCanvas]);

  // Download as ZIP. Native shells route through the OS share sheet so the
  // user can save the .zip to Files, AirDrop it, etc. — a plain in-WebView
  // <a download> doesn't have a filesystem destination on iOS/Android.
  const handleDownloadZip = useCallback(async () => {
    setDownloading(true);
    track('batch_export_zip', { count: doneImages.length, format });
    try {
      // Pre-generate outputCanvas for any 'edited' images so buildBatchZip
      // has a complete set. The map projection includes the freshly-generated
      // canvas even though the state update from ensureOutputCanvas hasn't
      // flushed to `doneImages` yet.
      const imagesForZip = (await Promise.all(
        doneImages.map(async img => ({ ...img, outputCanvas: await ensureOutputCanvas(img) }))
      )).filter(img => img.outputCanvas);
      const zipBlob = await buildBatchZip(imagesForZip, format, quality / 100);
      const zipName = `redactid_batch_${Date.now().toString(36)}.zip`;
      if (isNative) {
        await shareNativeFile(zipBlob, zipName, 'application/zip');
      } else {
        downloadBlob(zipBlob, zipName);
      }
    } catch (err) {
      console.error('[BatchExport] Zip failed:', err);
    } finally {
      setDownloading(false);
    }
  }, [doneImages, format, quality, ensureOutputCanvas, isNative]);

  const handleDownloadOne = useCallback(async (img) => {
    setDownloadingId(img.id);
    // Also set the shared `downloading` flag so the ZIP and Save-All buttons
    // disable during a single-item download — prevents the user triggering a
    // concurrent bulk operation on the same canvases mid-download.
    setDownloading(true);
    try {
      const canvas = await ensureOutputCanvas(img);
      if (!canvas) return;
      const mime = FORMATS.find(f => f.key === format)?.mime || 'image/png';
      const blob = await canvasToBlob(canvas, mime, quality / 100);
      const stem = img.file?.name?.replace(/\.[^.]+$/, '') || 'image';
      const filename = `${stem}_protected.${format === 'jpg' ? 'jpg' : format}`;
      if (isNative) {
        await shareNativeFile(blob, filename, mime);
      } else {
        downloadBlob(blob, filename);
      }
    } catch (err) {
      console.error('[BatchExport] Single download failed:', err);
    } finally {
      setDownloadingId(null);
      setDownloading(false);
    }
  }, [format, quality, ensureOutputCanvas, isNative]);

  const handleDone = useCallback(() => {
    resetBatch();
    onDone();
  }, [resetBatch, onDone]);

  const toolbarContent = (
    <>
      <div className="batch-controls">
        <div className="batch-mode-toggle">
          {FORMATS.map(f => (
            <button
              key={f.key}
              className={`batch-mode-btn ${format === f.key ? 'active' : ''}`}
              onClick={() => setFormat(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        {format !== 'png' && (
          <div className="batch-slider-group">
            <label className="batch-slider-label">
              Quality
              <input
                type="range"
                min="10"
                max="100"
                value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
                className="batch-slider"
              />
              <span className="batch-slider-value">{quality}%</span>
            </label>
          </div>
        )}
      </div>

      <div className="batch-actions">
        {/* iOS: Save to Photos via share sheet */}
        {canShare && (
          <button
            className="btn btn-primary btn-lg"
            onClick={handleShareAll}
            disabled={sharing || downloading || doneImages.length === 0}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, verticalAlign: -3 }}>
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
              <polyline points="16 6 12 2 8 6" />
              <line x1="12" y1="2" x2="12" y2="15" />
            </svg>
            {sharing ? 'Preparing...' : `Save ${doneImages.length} to Photos`}
          </button>
        )}
        {/* Non-iOS: Download individual files (appear in gallery on Android) */}
        {!canShare && (
          <button
            className="btn btn-primary btn-lg"
            onClick={handleDownloadIndividual}
            disabled={downloading || doneImages.length === 0}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, verticalAlign: -3 }}>
              <path d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
            </svg>
            {downloadProgress
              ? `Downloading ${downloadProgress.done}/${downloadProgress.total}...`
              : `Download All (${doneImages.length})`
            }
          </button>
        )}
        <button
          className="btn btn-ghost btn-lg"
          onClick={handleDownloadZip}
          disabled={downloading || doneImages.length === 0}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, verticalAlign: -3 }}>
            <path d="m20.25 7.5-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0-3-3m3 3 3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" />
          </svg>
          {downloading && !downloadProgress ? 'Building ZIP...' : 'Download as ZIP'}
        </button>
        <button className="btn btn-ghost" onClick={handleDone}>
          Done
        </button>
      </div>
    </>
  );

  return (
    <ScreenShell
      backAction={onBack}
      backLabel="Back"
      stepLabel="Export"
      topRight={<span className="top-bar-count">{doneImages.length} ready</span>}
      toolbar={toolbarContent}
    >
      <div className="batch-export-summary">
        <p>
          {doneImages.length} image{doneImages.length !== 1 ? 's' : ''} processed
          {tattoosRemoved > 0 ? ` \u2022 ${tattoosRemoved} with tattoos removed` : ''}
          {facesBlurred > 0 ? ` \u2022 ${facesBlurred} with faces blurred` : ''}
        </p>
      </div>

      <div className="batch-grid">
        {images.map(img => (
          <div key={img.id} className="batch-card batch-export-card">
            {img.thumbnailUrl && (
              <img
                className="batch-card-thumb"
                src={img.thumbnailUrl}
                alt={img.file?.name || 'Image'}
              />
            )}
            <div className="batch-card-info">
              {img.status === 'done' ? (
                <span className="batch-badge batch-badge-green">
                  {img.detections?.length || 0} {(img.detections?.length || 0) === 1 ? 'face' : 'faces'}
                </span>
              ) : img.status === 'edited' ? (
                <span className="batch-badge batch-badge-purple">Edited</span>
              ) : img.status === 'error' ? (
                <span className="batch-badge batch-badge-red" title={img.error || 'Unknown error'}>Error</span>
              ) : (
                <span className="batch-badge batch-badge-dim">No faces</span>
              )}
            </div>
            <button
              className="batch-card-download"
              onClick={() => handleDownloadOne(img)}
              disabled={downloadingId === img.id}
              aria-label={`Download ${img.file?.name || 'image'}`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
              </svg>
            </button>
          </div>
        ))}
      </div>

    </ScreenShell>
  );
}
