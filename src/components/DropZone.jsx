import { useState, useRef, useCallback, useEffect } from 'react';
import { usePipeline } from '../context/PipelineContext';
import { useBatch } from '../context/BatchContext';
import { useImagePipeline } from '../hooks/useImagePipeline';
import { useCoachMarks, suppressAllWalkthroughs, resetWalkthrough } from '../hooks/useCoachMarks';
import CoachMark from './CoachMark';
import ResolutionTierModal from './ResolutionTierModal';
import { track } from '../utils/analytics';
import { getSessionInfo, loadSession, clearSession } from '../utils/sessionStore';
import TipsToggle from './TipsToggle';
import '../styles/DropZone.css';

// Format ms delta as a terse relative time for the restore banner.
// Sessions are discarded after 24h (see sessionStore.getSessionInfo), so we
// don't need to handle anything older than that.
function formatTimeAgo(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function screenLabel(screen) {
  switch (screen) {
    case 'mask-edit': return 'editing';
    case 'review': return 'review';
    case 'export': return 'export';
    default: return null;
  }
}

export default function DropZone() {
  const { setOriginalFile, setScreen, restoreSession, setWarning, setSelectedTierMP } = usePipeline();
  const { seedFiles } = useBatch();
  const { runPipeline } = useImagePipeline();
  const [dragActive, setDragActive] = useState(false);
  const [savedSession, setSavedSession] = useState(null);
  const [restoring, setRestoring] = useState(false);
  // Pending upload — set when the user picks a file but hasn't yet chosen
  // a resolution tier. Holds { file, width, height } while the modal is open.
  const [pendingUpload, setPendingUpload] = useState(null);
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const dropTargetRef = useRef(null);

  const isMobile = /Mobi|Android/i.test(navigator.userAgent);

  const COACH_STEPS = [
    { targetRef: dropTargetRef, position: 'top', body: isMobile
      ? 'Tap to choose photos from your gallery, or use the camera button below to take one.'
      : 'Drop an image, click to browse, or paste from clipboard.' },
  ];
  const { activeStep, totalSteps, next, dismiss, isActive, restart } = useCoachMarks('drop', COACH_STEPS.length);

  useEffect(() => { getSessionInfo().then(setSavedSession); }, []);

  // Hidden admin access: tap logo 5 times
  const tapCountRef = useRef(0);
  const tapTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(tapTimerRef.current), []);
  const handleLogoTap = useCallback(() => {
    tapCountRef.current++;
    clearTimeout(tapTimerRef.current);
    tapTimerRef.current = setTimeout(() => { tapCountRef.current = 0; }, 1500);
    if (tapCountRef.current >= 5) {
      tapCountRef.current = 0;
      setScreen('admin');
    }
  }, []);

  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

  // Peek at image dimensions so the tier modal can disable options that
  // would exceed the source resolution. Resolves to { width, height } or
  // null if the image can't be decoded (the pipeline will surface the
  // real error later).
  const readImageSize = useCallback((file) => new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  }), []);

  const handleMultipleFiles = useCallback((files) => {
    const imageFiles = files.filter(f => f.type.startsWith('image/') && f.size <= MAX_FILE_SIZE);
    if (imageFiles.length === 0) return;
    const capped = imageFiles.slice(0, 20);
    if (imageFiles.length > 20) {
      setWarning('Maximum 20 images per batch. First 20 selected.');
    }
    track('batch_upload', { count: capped.length });
    seedFiles(capped);
    setScreen('batch-grid');
  }, [setScreen, setWarning]);

  const handleFile = useCallback(async (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    if (file.size > MAX_FILE_SIZE) {
      alert(`File too large (${(file.size / 1024 / 1024).toFixed(0)}MB). Maximum is 50MB.`);
      return;
    }
    track('image_uploaded', { file_type: file.type, file_size_kb: Math.round(file.size / 1024) });
    const size = await readImageSize(file);
    if (!size) {
      // Fall through to the normal pipeline so the user sees the real decode
      // error in the loading overlay instead of a modal stuck on 0×0.
      setOriginalFile(file);
      await runPipeline(file);
      return;
    }
    // Defer the pipeline kickoff until the user picks a tier.
    setPendingUpload({ file, width: size.width, height: size.height });
  }, [setOriginalFile, runPipeline, readImageSize]);

  // ResolutionTierModal emits `(mp, selectedKey)` on confirm; we only need
  // `mp` here because the modal already persists the key to localStorage
  // internally via saveTierKey. See ResolutionTierModal's JSDoc for the
  // full contract before wiring up a new caller.
  const handleTierSelect = useCallback(async (tierMP) => {
    if (!pendingUpload) return;
    const { file } = pendingUpload;
    setPendingUpload(null);
    setSelectedTierMP(tierMP);
    setOriginalFile(file);
    await runPipeline(file, tierMP);
  }, [pendingUpload, setOriginalFile, runPipeline, setSelectedTierMP]);

  const handleTierCancel = useCallback(() => {
    setPendingUpload(null);
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    if (files.length > 1) {
      handleMultipleFiles(Array.from(files));
    } else {
      handleFile(files[0]);
    }
  }, [handleFile, handleMultipleFiles]);

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
    const input = e.target;
    const files = Array.from(input.files || []);
    // Reset the input so picking the same file a second time still fires
    // onChange. Without this, cancelling the resolution-tier modal and then
    // re-selecting the same image silently does nothing (browser sees no
    // value change and skips the event).
    input.value = '';
    if (files.length === 0) return;
    if (files.length > 1) {
      handleMultipleFiles(files);
    } else {
      handleFile(files[0]);
    }
  }, [handleFile, handleMultipleFiles]);

  // Listen for paste events at the document level so the user can paste an
  // image without having to click into a specific element first. Attaching to
  // the <main> element instead required tabIndex={0}, which put a non-interactive
  // landmark into the tab order.
  useEffect(() => {
    const onPaste = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) handleFile(file);
          break;
        }
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [handleFile]);

  const onCameraCapture = useCallback(() => {
    cameraInputRef.current?.click();
  }, []);

  const handleRestore = useCallback(async () => {
    setRestoring(true);
    try {
      const session = await loadSession();
      if (session) {
        restoreSession(session);
      } else {
        setSavedSession(null);
      }
    } catch (e) {
      console.warn('[sessionStore] restore failed:', e?.message || e);
      setSavedSession(null);
      setWarning({ message: 'Couldn\'t restore your previous session — the saved data may be corrupt. Starting fresh.', sticky: true });
      // Best-effort cleanup of the corrupt entry so the next visit doesn't
      // offer to restore it again.
      clearSession().catch(() => {});
    } finally {
      setRestoring(false);
    }
  }, [restoreSession, setWarning]);

  const handleDismissSession = useCallback(() => {
    clearSession();
    setSavedSession(null);
  }, []);

  return (
    <main className="dropzone-screen">
      <TipsToggle active={isActive} onClick={() => {
        if (isActive) { suppressAllWalkthroughs(); dismiss(); }
        else { resetWalkthrough(); restart(); }
      }} />
      <div className="dropzone-header">
        <h1 className="dropzone-title" onClick={handleLogoTap}>
          <img className="dropzone-logo dropzone-logo-dark" src="/logo-dark-fixed.png" alt="IdentityHide" />
          <img className="dropzone-logo dropzone-logo-light" src="/logo-light-fixed.png" alt="IdentityHide" />
        </h1>
        <p className="dropzone-tagline">Share photos without revealing who you are or where you&apos;ve been. Faces blurred, tattoos removed, location data wiped.</p>
      </div>

      {savedSession && (
        <div className="dropzone-restore">
          <span>
            Unsaved work
            {savedSession.filename && <> on <strong>{savedSession.filename}</strong></>}
            {screenLabel(savedSession.screen) && <> ({screenLabel(savedSession.screen)})</>}
            {' — '}{formatTimeAgo(savedSession.savedAt)}
          </span>
          <div className="dropzone-restore-actions">
            <button className="btn btn-primary btn-sm" onClick={handleRestore} disabled={restoring}>
              {restoring ? 'Restoring...' : 'Resume'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={handleDismissSession}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <button
        ref={dropTargetRef}
        type="button"
        className={`dropzone-target ${dragActive ? 'dropzone-active' : ''}`}
        aria-label="Upload an image"
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
          <p className="dropzone-label">{isMobile ? 'Tap to choose photos' : 'Drop photos here or click to browse'}</p>
        </div>
      </button>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={onFileSelect}
        className="dropzone-input"
        aria-label="Choose image files"
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onFileSelect}
        className="dropzone-input"
        aria-label="Take a photo with camera"
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
          <span className="feature-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="5"/><path d="M3 21v-2a7 7 0 0 1 14 0v2"/></svg>
          </span>
          <span>Face detection & blur</span>
        </div>
        <div className="feature">
          <span className="feature-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M3 12h18M3 18h18"/><line x1="2" y1="2" x2="22" y2="22" strokeWidth="2.5"/></svg>
          </span>
          <span>Tattoo removal</span>
        </div>
        <div className="feature">
          <span className="feature-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </span>
          <span>Metadata stripped</span>
        </div>
      </div>

      <div className="dropzone-bottom-links">
        <a href="/feedback" className="dropzone-feedback-link">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          Send Feedback
        </a>
        <a href="/terms" className="dropzone-feedback-link">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="8" y1="13" x2="16" y2="13" />
            <line x1="8" y1="17" x2="16" y2="17" />
          </svg>
          Terms
        </a>
        <a href="/privacy" className="dropzone-feedback-link">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          Privacy
        </a>
        <a href="/faq" className="dropzone-feedback-link">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          FAQ
        </a>
      </div>

      {isActive && COACH_STEPS[activeStep] && (
        <CoachMark
          {...COACH_STEPS[activeStep]}
          stepIndex={activeStep}
          totalSteps={totalSteps}
          screenKey="drop"
          onNext={next}
          onDismiss={dismiss}
          onDismissAll={() => { suppressAllWalkthroughs(); dismiss(); }}
        />
      )}

      {pendingUpload && (
        <ResolutionTierModal
          srcWidth={pendingUpload.width}
          srcHeight={pendingUpload.height}
          onSelect={handleTierSelect}
          onCancel={handleTierCancel}
        />
      )}
    </main>
  );
}
