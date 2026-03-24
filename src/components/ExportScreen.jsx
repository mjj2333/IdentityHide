import { useRef, useEffect, useState, useCallback } from 'react';
import { usePipeline } from '../context/PipelineContext';
import { canvasToBlob, downloadBlob, generateExportFilename } from '../utils/imageHelpers';

export default function ExportScreen() {
  const {
    outputCanvasRef,
    originalCanvasRef,
    metadata,
    reset,
    setScreen,
  } = usePipeline();

  const previewRef = useRef(null);
  const [format, setFormat] = useState('png');
  const [quality, setQuality] = useState(92);
  const [showOriginal, setShowOriginal] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [fileSize, setFileSize] = useState(null);

  // Draw preview
  useEffect(() => {
    const canvas = previewRef.current;
    const source = showOriginal ? originalCanvasRef.current : outputCanvasRef.current;
    if (!canvas || !source) return;

    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0);
  }, [showOriginal, outputCanvasRef, originalCanvasRef]);

  // Estimate file size
  useEffect(() => {
    const output = outputCanvasRef.current;
    if (!output) return;

    const mimeType = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
    canvasToBlob(output, mimeType, quality / 100).then((blob) => {
      setFileSize(blob.size);
    }).catch(() => {});
  }, [format, quality, outputCanvasRef]);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    try {
      const output = outputCanvasRef.current;
      if (!output) return;

      const ext = format === 'jpeg' ? 'jpg' : format;
      const mimeType = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
      const blob = await canvasToBlob(output, mimeType, quality / 100);
      const filename = generateExportFilename(ext);
      downloadBlob(blob, filename);
    } finally {
      setDownloading(false);
    }
  }, [format, quality, outputCanvasRef]);

  const handleShare = useCallback(async () => {
    if (!navigator.share || !navigator.canShare) return;
    const output = outputCanvasRef.current;
    if (!output) return;

    const mimeType = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
    const ext = format === 'jpeg' ? 'jpg' : format;
    const blob = await canvasToBlob(output, mimeType, quality / 100);
    const file = new File([blob], generateExportFilename(ext), { type: mimeType });

    if (navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
    }
  }, [format, quality, outputCanvasRef]);

  const formatSize = (bytes) => {
    if (!bytes) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const dims = outputCanvasRef.current
    ? `${outputCanvasRef.current.width} x ${outputCanvasRef.current.height}`
    : '';

  return (
    <div className="export-screen">
      <div className="export-header">
        <h2>Export Protected Image</h2>
        <p className="export-subtitle">All metadata has been stripped. Your image is ready.</p>
      </div>

      <div className="export-layout">
        <div className="export-preview-wrap">
          <canvas ref={previewRef} className="export-canvas" />
          <div className="compare-controls">
            <button
              className={`compare-toggle-btn ${showOriginal ? 'active' : ''}`}
              onClick={() => setShowOriginal(v => !v)}
            >
              {showOriginal ? 'Showing Original' : 'Show Original'}
            </button>
            <span className="compare-label">{showOriginal ? 'Original (before)' : 'Protected (after)'}</span>
          </div>
        </div>

        <div className="export-sidebar">
          <div className="export-panel">
            <h3>Format</h3>
            <div className="format-options">
              {[
                { value: 'png', label: 'PNG', desc: 'Lossless, larger file' },
                { value: 'jpeg', label: 'JPEG', desc: 'Smaller file, adjustable quality' },
                { value: 'webp', label: 'WebP', desc: 'Modern, best compression' },
              ].map((f) => (
                <label key={f.value} className={`format-option ${format === f.value ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="format"
                    value={f.value}
                    checked={format === f.value}
                    onChange={(e) => setFormat(e.target.value)}
                  />
                  <div>
                    <strong>{f.label}</strong>
                    <span>{f.desc}</span>
                  </div>
                </label>
              ))}
            </div>

            {format !== 'png' && (
              <label className="quality-slider">
                <span>Quality: {quality}%</span>
                <input
                  type="range"
                  min="10"
                  max="100"
                  value={quality}
                  onChange={(e) => setQuality(parseInt(e.target.value))}
                />
              </label>
            )}
          </div>

          <div className="export-panel">
            <h3>File Info</h3>
            <p className="file-info">{dims}</p>
            <p className="file-info">Estimated size: {formatSize(fileSize)}</p>
          </div>

          <div className="export-panel metadata-confirmation">
            <h3>Privacy Checklist</h3>
            <ul className="checklist">
              <li className="check-done">EXIF data stripped</li>
              <li className="check-done">GPS coordinates removed</li>
              <li className="check-done">Camera info removed</li>
              <li className="check-done">Timestamps removed</li>
              <li className="check-done">Original filename not used</li>
              <li className="check-done">ICC profiles removed</li>
            </ul>
          </div>

          <div className="export-actions">
            <button
              className="btn btn-primary btn-large"
              onClick={handleDownload}
              disabled={downloading}
            >
              {downloading ? 'Saving...' : 'Download'}
            </button>
            {typeof navigator !== 'undefined' && navigator.share && (
              <button className="btn btn-secondary" onClick={handleShare}>
                Share
              </button>
            )}
            <button className="btn btn-secondary" onClick={() => setScreen('editor')}>
              Back to Editor
            </button>
            <button className="btn btn-ghost" onClick={() => {
              if (window.confirm('Start over with a different image? All progress will be lost.')) reset();
            }}>
              Start Over
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
