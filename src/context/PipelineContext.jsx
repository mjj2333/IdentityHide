import { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { encodeCanvas, writeSession, clearSession } from '../utils/sessionStore';
import { createSessionSaver } from '../utils/sessionSaver';
import { diagLog, diagSpan } from '../utils/perfDiagnostics';
import { getTierMP, getSavedTierKey } from '../utils/resolutionTiers';
import { migrateBlurSettings } from '../utils/blurEngine';

const PipelineContext = createContext(null);

// The persisted settings. One builder for both the save path and the restore
// path, so they produce identical JSON — the session saver compares it as a
// string to decide whether anything changed.
const sessionMeta = ({ screen, blurSettings, feather, detections, editDets, tierMP }) =>
  ({ screen, blurSettings, feather, detections, editDets, tierMP });

export function PipelineProvider({ children }) {
  const [screen, setScreen] = useState('drop');
  const [originalFile, setOriginalFile] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [detections, setDetections] = useState([]);
  const [detectionToggles, setDetectionToggles] = useState([]);
  const [blurSettings, setBlurSettings] = useState({
    mode: 'gaussian',       // 'none' | 'gaussian' | 'pixelate' — the blur layer
    stickerEnabled: false,  // independent sticker overlay, layers on top of the blur
    strength: 20,
    barWidth: 20,
    barLength: 110,
    barAngle: 0,
    barStyle: 'solid',
    barColor: '#000000',
  });
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
  const faceBlurCanvasRef = useRef(null);
  const tattooMaskDirtyRef = useRef(true);
  // Tracks whether we've already consumed a free tattoo credit for the
  // current pipeline session (i.e. the current uploaded image). Retouching
  // the same image after a successful Apply MUST NOT consume another credit
  // — that would charge users for iteration, not for distinct photos. The
  // flag is reset on reset() and at the start of every runPipeline.
  const tattooCreditClaimedRef = useRef(false);
  // Incremental session saver (see sessionSaver.js) — one per provider, it
  // remembers what is already on disk.
  const [saver] = useState(() => createSessionSaver({ encode: encodeCanvas, write: writeSession }));
  const [editDets, setEditDets] = useState([]);
  const [editorReturnMode, setEditorReturnMode] = useState(null);

  const reset = useCallback(() => {
    // Release canvas bitmap memory before clearing refs
    const canvasRefs = [strippedCanvasRef, originalCanvasRef, outputCanvasRef, tattooMaskCanvasRef, inpaintedCanvasRef, faceBlurCanvasRef];
    for (const ref of canvasRefs) {
      if (ref.current) {
        ref.current.width = 0;
        ref.current.height = 0;
        ref.current = null;
      }
    }

    saver.reset(); // also stops an in-flight save from writing
    clearSession();
    setScreen('drop');
    setOriginalFile(null);
    setMetadata(null);
    setDetections([]);
    setDetectionToggles([]);
    setBlurSettings({ mode: 'gaussian', stickerEnabled: false, strength: 20, barWidth: 20, barLength: 110, barAngle: 0, barStyle: 'solid', barColor: '#000000' });
    setFeather(0);
    setBrushSettings({ tool: 'brush', size: 30 });
    setStatus('idle');
    setError(null);
    setWarning(null);
    setSelectedTierMP(getTierMP(getSavedTierKey()));
    samScaleRef.current = null;
    tattooMaskDirtyRef.current = true;
    tattooCreditClaimedRef.current = false;
    setEditDets([]);
    setEditorReturnMode(null);
  }, [saver]);

  // Auto-save to IndexedDB when screen changes (debounced to avoid thrashing)
  const saveTimerRef = useRef(null);
  // Suppress repeat save-failure warnings — the auto-save fires on every state
  // change and a persistent QuotaExceededError would otherwise spam the toast.
  // Reset on the next successful save so transient errors still get surfaced.
  const saveFailedRef = useRef(false);
  // Diagnostics only (?diag=1): true while a debounced save is waiting to
  // fire, so rapid state changes (e.g. dragging a region) log one
  // 'save-scheduled' rather than one per pointermove.
  const saveQueuedRef = useRef(false);
  useEffect(() => {
    if (screen === 'drop' || status !== 'ready') { saveQueuedRef.current = false; return; }
    clearTimeout(saveTimerRef.current);
    if (!saveQueuedRef.current) {
      saveQueuedRef.current = true;
      diagLog('save-scheduled', { screen });
    }
    saveTimerRef.current = setTimeout(async () => {
      saveQueuedRef.current = false;
      diagLog('save-start');
      const endSave = diagSpan('save-end');
      try {
        // The saver diffs against what's already on disk and writes only the
        // change; canvases are read when the save actually starts.
        await saver.save(() => ({
          meta: sessionMeta({ screen, blurSettings, feather, detections, editDets, tierMP: selectedTierMP }),
          originalFile,
          canvases: {
            tattooMask: tattooMaskCanvasRef.current,
            stripped: strippedCanvasRef.current,
            inpainted: inpaintedCanvasRef.current,
            output: outputCanvasRef.current,
          },
        }));
        saveFailedRef.current = false;
        endSave();
      } catch (e) {
        diagLog('save-error', { error: e?.name || String(e) });
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
  }, [screen, originalFile, blurSettings, feather, detections, editDets, status, selectedTierMP, saver]);

  const restoreSession = useCallback((session) => {
    const restored = {
      screen: session.screen || 'mask-edit',
      blurSettings: migrateBlurSettings(session.blurSettings) || { mode: 'gaussian', stickerEnabled: false, strength: 20, barWidth: 20, barLength: 110, barAngle: 0, barStyle: 'solid', barColor: '#000000' },
      feather: session.feather || 0,
      detections: session.detections || [],
      editDets: session.editDets || [],
      // Sessions saved before resolution tiers existed have no tierMP — default
      // to 1 MP, which matches the old hardcoded WORKING_MP behaviour.
      tierMP: session.tierMP || 1,
    };
    setOriginalFile(session.originalFile);
    setBlurSettings(restored.blurSettings);
    setFeather(restored.feather);
    setDetections(restored.detections);
    setEditDets(restored.editDets);
    setSelectedTierMP(restored.tierMP);
    if (session.strippedCanvas) strippedCanvasRef.current = session.strippedCanvas;
    if (session.originalCanvas) originalCanvasRef.current = session.originalCanvas;
    if (session.outputCanvas) outputCanvasRef.current = session.outputCanvas;
    if (session.tattooMaskCanvas) tattooMaskCanvasRef.current = session.tattooMaskCanvas;
    if (session.inpaintedCanvas) inpaintedCanvasRef.current = session.inpaintedCanvas;
    // What was just loaded is, by definition, already on disk — without this
    // the state changes below would trigger a full re-save of the session the
    // moment the editor appears. (A legacy-layout session has nothing under
    // the new keys yet, so it must be written in full once.)
    if (!session.legacy) {
      saver.adopt({
        meta: sessionMeta(restored),
        originalFile: session.originalFile,
        canvases: {
          tattooMask: tattooMaskCanvasRef.current,
          stripped: strippedCanvasRef.current,
          inpainted: inpaintedCanvasRef.current,
          output: outputCanvasRef.current,
        },
      });
    }
    tattooMaskDirtyRef.current = false;
    setStatus('ready');
    setScreen(restored.screen);
  }, [saver]);

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
    faceBlurCanvasRef,
    tattooMaskDirtyRef,
    tattooCreditClaimedRef,
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
