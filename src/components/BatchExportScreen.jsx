import { useState, useCallback, useMemo } from 'react';
import { useBatch } from '../context/BatchContext';
import { buildBatchZip, applyBatchBlur, hasPaintedPixels } from '../utils/batchProcessor';
import { canvasToBlob, downloadBlob } from '../utils/imageHelpers';
import { track } from '../utils/analytics';

const FORMATS = [
  { key: 'png', label: 'PNG', mime: 'image/png' },
  { key: 'jpg', label: 'JPEG', mime: 'image/jpeg' },
  { key: 'webp', label: 'WebP', mime: 'image/webp' },
];

export default function BatchExportScreen({ onDone, onBack }) {
  const { images, resetBatch, globalBlurSettings, globalFeather, updateImage } = useBatch();
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
  const ensureOutputCanvas = useCallback((img) => {
    if (img.outputCanvas) return img.outputCanvas;
    if (!img.strippedCanvas) return null;
    const canvas = applyBatchBlur(img, globalBlurSettings, globalFeather);
    updateImage(img.id, { outputCanvas: canvas, status: 'done' });
    return canvas;
  }, [globalBlurSettings, globalFeather, updateImage]);

  const isIOS = useMemo(() => /iPad|iPhone|iPod/.test(navigator.userAgent), []);

  const canShare = useMemo(() => {
    if (!isIOS) return false; // Only use share sheet on iOS where "Save to Photos" is clear
    if (typeof navigator === 'undefined' || !navigator.share || !navigator.canShare) return false;
    try {
      const testFile = new File(['test'], 'test.png', { type: 'image/png' });
      return navigator.canShare({ files: [testFile] });
    } catch {
      return false;
    }
  }, [isIOS]);

  // Share via Web Share API — saves directly to Photos on iOS/Android
  const handleShareAll = useCallback(async () => {
    if (!canShare || doneImages.length === 0) return;
    setSharing(true);
    track('batch_export_share', { count: doneImages.length, format });

    try {
      const mime = FORMATS.find(f => f.key === format)?.mime || 'image/png';
      const ext = format === 'jpg' ? 'jpg' : format;
      const files = [];

      for (const img of doneImages) {
        const canvas = ensureOutputCanvas(img);
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
  }, [canShare, doneImages, format, quality, ensureOutputCanvas]);

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
      const canvas = ensureOutputCanvas(img);
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

  // Download as ZIP
  const handleDownloadZip = useCallback(async () => {
    setDownloading(true);
    track('batch_export_zip', { count: doneImages.length, format });
    try {
      // Pre-generate outputCanvas for any 'edited' images so buildBatchZip
      // has a complete set. The map projection includes the freshly-generated
      // canvas even though the state update from ensureOutputCanvas hasn't
      // flushed to `doneImages` yet.
      const imagesForZip = doneImages
        .map(img => ({ ...img, outputCanvas: ensureOutputCanvas(img) }))
        .filter(img => img.outputCanvas);
      const zipBlob = await buildBatchZip(imagesForZip, format, quality / 100);
      downloadBlob(zipBlob, `identityhide_batch_${Date.now().toString(36)}.zip`);
    } catch (err) {
      console.error('[BatchExport] Zip failed:', err);
    } finally {
      setDownloading(false);
    }
  }, [doneImages, format, quality, ensureOutputCanvas]);

  const handleDownloadOne = useCallback(async (img) => {
    setDownloadingId(img.id);
    // Also set the shared `downloading` flag so the ZIP and Save-All buttons
    // disable during a single-item download — prevents the user triggering a
    // concurrent bulk operation on the same canvases mid-download.
    setDownloading(true);
    try {
      const canvas = ensureOutputCanvas(img);
      if (!canvas) return;
      const mime = FORMATS.find(f => f.key === format)?.mime || 'image/png';
      const blob = await canvasToBlob(canvas, mime, quality / 100);
      const stem = img.file?.name?.replace(/\.[^.]+$/, '') || 'image';
      downloadBlob(blob, `${stem}_protected.${format === 'jpg' ? 'jpg' : format}`);
    } catch (err) {
      console.error('[BatchExport] Single download failed:', err);
    } finally {
      setDownloadingId(null);
      setDownloading(false);
    }
  }, [format, quality, ensureOutputCanvas]);

  const handleDone = useCallback(() => {
    resetBatch();
    onDone();
  }, [resetBatch, onDone]);

  return (
    <div className="batch-screen">
      <header className="batch-header">
        <button className="btn btn-ghost" onClick={onBack}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </button>
        <h2 className="batch-title">Export</h2>
        <span className="batch-count">{doneImages.length} photos ready</span>
      </header>

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
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      <div className="batch-bottom">
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
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, verticalAlign: -3 }}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {downloadProgress
                ? `Saving ${downloadProgress.done}/${downloadProgress.total}...`
                : `Save All (${doneImages.length})`
              }
            </button>
          )}
          <button
            className="btn btn-ghost btn-lg"
            onClick={handleDownloadZip}
            disabled={downloading || doneImages.length === 0}
          >
            {downloading && !downloadProgress ? 'Building ZIP...' : 'Download as ZIP'}
          </button>
          <button className="btn btn-ghost" onClick={handleDone}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
