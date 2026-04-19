import { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { saveSession, clearSession } from '../utils/sessionStore';
import { getTierMP, getSavedTierKey } from '../utils/resolutionTiers';

const PipelineContext = createContext(null);

export function PipelineProvider({ children }) {
  const [screen, setScreen] = useState('drop');
  const [originalFile, setOriginalFile] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [detections, setDetections] = useState([]);
  const [detectionToggles, setDetectionToggles] = useState([]);
  const [blurSettings, setBlurSettings] = useState({ mode: 'gaussian', strength: 20, barWidth: 20, barLength: 110, barAngle: 0 });
  const [feather, setFeather] = useState(0);
  const [brushSettings, setBrushSettings] = useState({ tool: 'brush', size: 30 });
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  // Non-blocking soft warning (toast-style). Distinct from `error` so the
  // user can still interact with the app.
  const [warning, setWarning] = useState(null);
  // Working-resolution megapixel count chosen for the current image.
  // Initialized from the user's saved preference so a refreshed page with
  // no active session still reflects their last choice.
  const [selectedTierMP, setSelectedTierMP] = useState(() => getTierMP(getSavedTierKey()));

  const strippedCanvasRef = useRef(null);
  const originalCanvasRef = useRef(null);
  const outputCanvasRef = useRef(null);
  const tattooMaskCanvasRef = useRef(null);
  const samScaleRef = useRef(null);
  const inpaintedCanvasRef = useRef(null);
  const fullResCanvasRef = useRef(null);
  const faceBlurCanvasRef = useRef(null);
  const tattooMaskDirtyRef = useRef(true);
  const [editDets, setEditDets] = useState([]);
  const [editorReturnMode, setEditorReturnMode] = useState(null);

  const reset = useCallback(() => {
    // Release canvas bitmap memory before clearing refs
    const canvasRefs = [strippedCanvasRef, originalCanvasRef, outputCanvasRef, tattooMaskCanvasRef, inpaintedCanvasRef, fullResCanvasRef, faceBlurCanvasRef];
    for (const ref of canvasRefs) {
      if (ref.current) {
        ref.current.width = 0;
        ref.current.height = 0;
        ref.current = null;
      }
    }

    clearSession();
    setScreen('drop');
    setOriginalFile(null);
    setMetadata(null);
    setDetections([]);
    setDetectionToggles([]);
    setBlurSettings({ mode: 'gaussian', strength: 20, barWidth: 20, barLength: 110, barAngle: 0 });
    setFeather(0);
    setBrushSettings({ tool: 'brush', size: 30 });
    setStatus('idle');
    setError(null);
    setWarning(null);
    setSelectedTierMP(getTierMP(getSavedTierKey()));
    samScaleRef.current = null;
    tattooMaskDirtyRef.current = true;
    setEditDets([]);
    setEditorReturnMode(null);
  }, []);

  // Auto-save to IndexedDB when screen changes (debounced to avoid thrashing)
  const saveTimerRef = useRef(null);
  // Suppress repeat save-failure warnings — the auto-save fires on every state
  // change and a persistent QuotaExceededError would otherwise spam the toast.
  // Reset on the next successful save so transient errors still get surfaced.
  const saveFailedRef = useRef(false);
  useEffect(() => {
    if (screen === 'drop' || status !== 'ready') return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        await saveSession({
          originalFile,
          screen,
          blurSettings,
          feather,
          detections,
          editDets,
          tierMP: selectedTierMP,
          tattooMaskCanvas: tattooMaskCanvasRef.current,
          strippedCanvas: strippedCanvasRef.current,
          inpaintedCanvas: inpaintedCanvasRef.current,
          outputCanvas: outputCanvasRef.current,
          originalCanvas: originalCanvasRef.current,
          fullResCanvas: fullResCanvasRef.current,
        });
        saveFailedRef.current = false;
      } catch (e) {
        console.warn('[sessionStore] save failed:', e?.message || e);
        if (!saveFailedRef.current) {
          saveFailedRef.current = true;
          const quota = e?.name === 'QuotaExceededError';
          setWarning({
            message: quota
              ? 'Auto-save disabled — browser storage is full. Your current work is safe but won\'t survive a page reload.'
              : 'Auto-save failed — your current work is safe but won\'t survive a page reload.',
            sticky: true,
          });
        }
      }
    }, 1000);
    return () => clearTimeout(saveTimerRef.current);
  }, [screen, originalFile, blurSettings, feather, detections, editDets, status, selectedTierMP]);

  const restoreSession = useCallback((session) => {
    setOriginalFile(session.originalFile);
    setBlurSettings(session.blurSettings || { mode: 'gaussian', strength: 20, barWidth: 20, barLength: 110, barAngle: 0 });
    setFeather(session.feather || 0);
    setDetections(session.detections || []);
    setEditDets(session.editDets || []);
    // Sessions saved before resolution tiers existed have no tierMP — default
    // to 1 MP, which matches the old hardcoded WORKING_MP behaviour.
    setSelectedTierMP(session.tierMP || 1);
    if (session.strippedCanvas) strippedCanvasRef.current = session.strippedCanvas;
    if (session.originalCanvas) originalCanvasRef.current = session.originalCanvas;
    if (session.outputCanvas) outputCanvasRef.current = session.outputCanvas;
    if (session.tattooMaskCanvas) tattooMaskCanvasRef.current = session.tattooMaskCanvas;
    if (session.inpaintedCanvas) inpaintedCanvasRef.current = session.inpaintedCanvas;
    if (session.fullResCanvas) fullResCanvasRef.current = session.fullResCanvas;
    tattooMaskDirtyRef.current = false;
    setStatus('ready');
    setScreen(session.screen || 'mask-edit');
  }, []);

  // Memoize so consumers don't re-render every time the provider re-renders.
  // Refs are stable and setters are stable, so only the listed state values
  // need to trigger a new context value.
  const value = useMemo(() => ({
    screen, setScreen,
    originalFile, setOriginalFile,
    metadata, setMetadata,
    detections, setDetections,
    detectionToggles, setDetectionToggles,
    blurSettings, setBlurSettings,
    feather, setFeather,
    brushSettings, setBrushSettings,
    status, setStatus,
    error, setError,
    warning, setWarning,
    selectedTierMP, setSelectedTierMP,
    strippedCanvasRef,
    originalCanvasRef,
    outputCanvasRef,
    tattooMaskCanvasRef,
    samScaleRef,
    inpaintedCanvasRef,
    fullResCanvasRef,
    faceBlurCanvasRef,
    tattooMaskDirtyRef,
    editDets, setEditDets,
    editorReturnMode, setEditorReturnMode,
    reset,
    restoreSession,
  }), [
    screen, originalFile, metadata, detections, detectionToggles,
    blurSettings, feather, brushSettings, status, error, warning,
    selectedTierMP, editDets, editorReturnMode, reset, restoreSession,
  ]);

  return (
    <PipelineContext.Provider value={value}>
      {children}
    </PipelineContext.Provider>
  );
}

export function usePipeline() {
  const ctx = useContext(PipelineContext);
  if (!ctx) throw new Error('usePipeline must be used within PipelineProvider');
  return ctx;
}
