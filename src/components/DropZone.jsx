import { useState, useRef, useCallback } from 'react';
import { usePipeline } from '../context/PipelineContext';
import { useImagePipeline } from '../hooks/useImagePipeline';
import '../styles/DropZone.css';

export default function DropZone() {
  const { setOriginalFile } = usePipeline();
  const { runPipeline } = useImagePipeline();
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);

  const handleFile = useCallback(async (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    setOriginalFile(file);
    await runPipeline(file);
  }, [setOriginalFile, runPipeline]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  }, []);

  const onDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  }, []);

  const onFileSelect = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onPaste = useCallback((e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) handleFile(file);
        break;
      }
    }
  }, [handleFile]);

  const onCameraCapture = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  return (
    <div className="dropzone-screen" onPaste={onPaste} tabIndex={0}>
      <div className="dropzone-header">
        <h1 className="dropzone-title">
          <span className="shield-icon">&#x1F6E1;</span> PixelShield
        </h1>
        <p className="dropzone-tagline">Protect identities in photos. Automatic face detection, metadata stripping, and smart blurring — all on-device.</p>
      </div>

      <div
        className={`dropzone-target ${dragActive ? 'dropzone-active' : ''}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => fileInputRef.current?.click()}
      >
        <div className="dropzone-content">
          <div className="dropzone-icon">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <p className="dropzone-label">Drop an image here, click to browse, or paste from clipboard</p>
          <p className="dropzone-formats">JPEG, PNG, WebP — processed entirely on your device</p>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onFileSelect}
        className="dropzone-input"
      />

      <button className="camera-btn" onClick={onCameraCapture}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
        Take Photo
      </button>

      <div className="dropzone-features">
        <div className="feature">
          <span className="feature-icon">&#x1F50D;</span>
          <span>Auto face detection</span>
        </div>
        <div className="feature">
          <span className="feature-icon">&#x1F4CD;</span>
          <span>GPS & metadata stripped</span>
        </div>
        <div className="feature">
          <span className="feature-icon">&#x1F512;</span>
          <span>100% on-device</span>
        </div>
      </div>
    </div>
  );
}
