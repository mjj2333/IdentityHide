import { useState, useRef, useCallback, useEffect } from 'react';
import { usePipeline } from '../context/PipelineContext';
import { useBatch } from '../context/BatchContext';
import { useEntitlement } from '../context/EntitlementContext';
import { useImagePipeline } from '../hooks/useImagePipeline';
import { useCoachMarks, suppressAllWalkthroughs, resetWalkthrough } from '../hooks/useCoachMarks';
import CoachMark from './CoachMark';
import ResolutionTierModal from './ResolutionTierModal';
import Wordmark from './Wordmark';
import { track } from '../utils/analytics';
import { isNativeApp } from '../utils/platform';
import { takeNativePhoto } from '../utils/nativeMedia';
import { useDocumentMeta } from '../hooks/useDocumentMeta';
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

// Icon set — minimal line weight, editorial feel. Kept local so the set is
// consistent with the Redact.ID home artboard and doesn't drift as future
// screens reuse Lucide or Heroicons elsewhere.
const UploadIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7.5 7.5h-.75A2.25 2.25 0 0 0 4.5 9.75v7.5a2.25 2.25 0 0 0 2.25 2.25h7.5a2.25 2.25 0 0 0 2.25-2.25v-7.5a2.25 2.25 0 0 0-2.25-2.25h-.75m0-3-3-3m0 0-3 3m3-3v11.25m6-2.25h.75a2.25 2.25 0 0 1 2.25 2.25v7.5a2.25 2.25 0 0 1-2.25 2.25h-7.5a2.25 2.25 0 0 1-2.25-2.25v-.75" />
  </svg>
);
const CameraIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
    <path d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" />
  </svg>
);
const BatchIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m2.25 7.125 9.75 5.625 9.75-5.625-9.75-5.625-9.75 5.625Z" />
    <path d="m2.25 12 9.75 5.625L21.75 12" />
    <path d="m2.25 16.875 9.75 5.625 9.75-5.625" />
  </svg>
);
const ChevRight = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

const FooterIcons = {
  feedback: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" /></svg>,
  terms: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>,
  privacy: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" /></svg>,
  faq: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" /></svg>,
  account: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>,
};

export default function DropZone() {
  useDocumentMeta({
    title: 'Redact.ID — Blur faces, remove tattoos, strip location from photos',
    description: 'Redact.ID protects identities in photos — blur faces, remove tattoos, and strip location metadata in your browser before you share. Free and private.',
    canonical: 'https://redactid.app/',
    ogImage: 'https://redactid.app/og-image.png',
  });
  const { setOriginalFile, setScreen, restoreSession, setWarning, setSelectedTierMP } = usePipeline();
  const { seedFiles } = useBatch();
  const { runPipeline } = useImagePipeline();
  const [dragActive, setDragActive] = useState(false);
  const [savedSession, setSavedSession] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const { premium } = useEntitlement();

  // Pending upload — set when the user picks a file but hasn't yet chosen
  // a resolution tier. Holds { file, width, height } while the modal is open.
  const [pendingUpload, setPendingUpload] = useState(null);
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const batchInputRef = useRef(null);
  const dropTargetRef = useRef(null);

  const isMobile = /Mobi|Android/i.test(navigator.userAgent);

  const COACH_STEPS = [
    { targetRef: dropTargetRef, position: 'top', title: 'Add a photo', body: isMobile
      ? 'Tap to choose photos from your gallery, or take one with the camera card below.'
      : 'Drop an image, click to browse, or paste from clipboard.' },
  ];
  const { activeStep, totalSteps, next, dismiss, isActive, restart } = useCoachMarks('drop', COACH_STEPS.length);

  useEffect(() => { getSessionInfo().then(setSavedSession); }, []);

  // Hidden admin access — five taps on the wordmark in 1.5s.
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
  }, [setScreen]);

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
    // Free tier caps a batch at 3 images; premium at 20.
    const cap = premium ? 20 : 3;
    const capped = imageFiles.slice(0, cap);
    if (imageFiles.length > cap) {
      setWarning(premium
        ? 'Maximum 20 images per batch. First 20 selected.'
        : isNativeApp()
          ? `Free batches are capped at ${cap} images. First ${cap} selected.`
          : `Free batches are capped at ${cap} images. First ${cap} selected. Go Premium for up to 20.`);
    }
    track('batch_upload', { count: capped.length });
    seedFiles(capped, cap);
    setScreen('batch-grid');
  }, [seedFiles, setScreen, setWarning, MAX_FILE_SIZE, premium]);

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
  }, [setOriginalFile, runPipeline, readImageSize, MAX_FILE_SIZE]);

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
    // re-selecting the same image silently does nothing.
    input.value = '';
    if (files.length === 0) return;
    if (files.length > 1) {
      handleMultipleFiles(files);
    } else {
      handleFile(files[0]);
    }
  }, [handleFile, handleMultipleFiles]);

  // Listen for paste at the document level so users don't have to focus a
  // specific element. Attaching to <main> would require tabIndex={0}, which
  // puts a non-interactive landmark into the tab order.
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

  const onCameraCapture = useCallback(async () => {
    // Native shells get the OS-native camera/library prompt via Capacitor.
    // Web stays on the file-input fallback (which renders the same chooser
    // through `capture="environment"` on mobile browsers).
    if (isNativeApp()) {
      try {
        const file = await takeNativePhoto({ source: 'prompt' });
        if (file) handleFile(file);
      } catch (err) {
        console.warn('[DropZone] native camera failed:', err);
        setWarning('Could not open camera. Please try again.');
      }
      return;
    }
    cameraInputRef.current?.click();
  }, [handleFile, setWarning]);
  const onBatchCapture = useCallback(() => batchInputRef.current?.click(), []);

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
    <main className="home-screen">
      <TipsToggle active={isActive} onClick={() => {
        if (isActive) { suppressAllWalkthroughs(); dismiss(); }
        else { resetWalkthrough(); restart(); }
      }} />

      {/* Wordmark + tagline */}
      <div className="home-header">
        <div className="home-wordmark" onClick={handleLogoTap}>
          <Wordmark size="hero" />
        </div>
        <p className="home-copy home-copy--primary">Share photos without revealing who you are.</p>
        <p className="home-copy home-copy--secondary">Faces blurred, tattoos removed, location data wiped.</p>
      </div>

      {savedSession && (
        <div className="home-restore" role="status">
          <div className="home-restore-body">
            <span className="home-restore-label">Unsaved work</span>
            {savedSession.filename && <span className="home-restore-file">{savedSession.filename}</span>}
            <span className="home-restore-meta">
              {screenLabel(savedSession.screen) && <>{screenLabel(savedSession.screen)} · </>}
              {formatTimeAgo(savedSession.savedAt)}
            </span>
          </div>
          <div className="home-restore-actions">
            <button className="btn btn-primary btn-sm" onClick={handleRestore} disabled={restoring}>
              {restoring ? 'Restoring…' : 'Resume'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={handleDismissSession}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Affordances */}
      <div className="home-affordances">
        <button
          ref={dropTargetRef}
          type="button"
          className={`home-card home-card--primary${dragActive ? ' is-dragactive' : ''}`}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="home-card-iconblock">
            <UploadIcon />
          </div>
          <div className="home-card-text">
            <div className="home-card-title">Choose a photo</div>
            <div className="home-card-sub">{isMobile ? 'From your library' : 'From library, files, or paste'}</div>
          </div>
          <ChevRight size={18} />
        </button>

        <button type="button" className="home-card home-card--ghost" onClick={onCameraCapture}>
          <div className="home-card-glyph"><CameraIcon /></div>
          <div className="home-card-text">
            <div className="home-card-title">Take photo</div>
          </div>
          <ChevRight size={16} />
        </button>

        <button type="button" className="home-card home-card--ghost" onClick={onBatchCapture}>
          <div className="home-card-glyph"><BatchIcon /></div>
          <div className="home-card-text">
            <div className="home-card-title">Batch mode</div>
            <div className="home-card-sub">Protect multiple photos at once</div>
          </div>
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={onFileSelect}
        className="home-input"
        aria-label="Choose image files"
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onFileSelect}
        className="home-input"
        aria-label="Take a photo with camera"
      />
      <input
        ref={batchInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={onFileSelect}
        className="home-input"
        aria-label="Choose multiple photos for batch"
      />

      <div className="home-footer-spacer" />

      <nav className="home-footer" aria-label="Info">
        <a href="/account" className="home-footer-link">
          <FooterIcons.account />
          <span>Account</span>
        </a>
        <a href="/feedback" className="home-footer-link">
          <FooterIcons.feedback />
          <span>Feedback</span>
        </a>
        <a href="/faq" className="home-footer-link">
          <FooterIcons.faq />
          <span>FAQ</span>
        </a>
        <a href="/terms" className="home-footer-link">
          <FooterIcons.terms />
          <span>Terms</span>
        </a>
        <a href="/privacy" className="home-footer-link">
          <FooterIcons.privacy />
          <span>Privacy</span>
        </a>
      </nav>

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
