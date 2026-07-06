import { useRef, useEffect, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePipeline } from '../context/PipelineContext';
import { useMaskEditor } from '../hooks/useMaskEditor';
import { useImagePipeline } from '../hooks/useImagePipeline';
import { useZoomPan } from '../hooks/useZoomPan';
import { useCoachMarks, suppressAllWalkthroughs } from '../hooks/useCoachMarks';
import { testConnection } from '../utils/comfyuiApi';
import { applyMaskedBlur, stackBlur, BLUR_MODE_LABELS, BAR_STYLES } from '../utils/blurEngine';
import ColorSpectrumPicker from './ColorSpectrumPicker';
import { track } from '../utils/analytics';
import ScreenShell from './ScreenShell';
import ConfirmModal from './ConfirmModal';
import CoachMark from './CoachMark';
import InsetZoom from './InsetZoom';
import { ProgressOverlay, ErrorOverlay } from './ApplyOverlay';
// Ad utilities are lazy-imported at the call sites below. All three networks
// (clickadilla / adsterra / applixir-via-paywall) are either disabled or
// only invoked deep in user flows, so eagerly bundling them into the
// MaskEditorScreen chunk wastes ~12-15KB of first-render JS for ~90% of
// sessions that never trigger an ad.
import { useEntitlement } from '../context/EntitlementContext';
import { canConsumeCredit, consumeCredit } from '../utils/credits';
import PaywallModal from './PaywallModal';
import RedeemCodeModal from './RedeemCodeModal';


export default function MaskEditorScreen() {
  const {
    strippedCanvasRef,
    tattooMaskCanvasRef,
    samScaleRef,
    detections,
    inpaintedCanvasRef,
    outputCanvasRef,
    faceBlurCanvasRef,
    editDets, setEditDets,
    blurSettings, setBlurSettings,
    feather, setFeather,
    setScreen,
    reset,
    tattooMaskDirtyRef,
    tattooCreditClaimedRef,
    editorReturnMode, setEditorReturnMode,
  } = usePipeline();

  const { recompositeWithCustomMask } = useImagePipeline();

  const displayRef = useRef(null);
  const canvasContainerRef = useRef(null);
  const globalListenersRef = useRef([]);
  const [applying, setApplying] = useState(false);
  const [applyStatus, setApplyStatus] = useState('');
  const [applyProgress, setApplyProgress] = useState(0);
  const [applyError, setApplyError] = useState(null);
  const [showPaywall, setShowPaywall] = useState(false);
  const [showRedeem, setShowRedeem] = useState(false);
  const { premium, syncCreditState } = useEntitlement();
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef(null);
  const abortRef = useRef(null);
  const blurRafRef = useRef(null);
  // Track mounted state so the rAF-scheduled blur-preview callback can no-op
  // if it somehow fires after unmount. cancelAnimationFrame already covers
  // the normal path; this is defense-in-depth matching the ExportScreen
  // pattern.
  const mountedRef = useRef(true);
  useEffect(() => {
    // Fire-and-forget lazy imports. Both modules guard themselves with
    // _ENABLED feature flags, so an undefined export or a module load
    // failure during transition is harmless.
    import('../utils/clickadillaAd').then((m) => { try { m.preloadAd?.(); } catch {} });
    import('../utils/adsterraAd').then((m) => { try { m.loadAdsterraPopunder?.(); } catch {} });
    return () => {
      clearInterval(timerRef.current);
      abortRef.current?.abort();
      globalListenersRef.current.forEach(fn => fn());
      globalListenersRef.current = [];
      cancelAnimationFrame(blurRafRef.current);
      mountedRef.current = false;
    };
  }, []);
  const [cursorPos, setCursorPos] = useState(null);
  const [renderKey, setRenderKey] = useState(0);
  const [comfyConnected, setComfyConnected] = useState(null);
  const [comfyBannerDismissed, setComfyBannerDismissed] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showOfflineConfirm, setShowOfflineConfirm] = useState(false);
  const [selectedOvalIdx, setSelectedOvalIdx] = useState(null);
  const [blurDropdownOpen, setBlurDropdownOpen] = useState(false);
  const [blurDropdownPos, setBlurDropdownPos] = useState(null);
  const blurDropdownRef = useRef(null);
  const blurTriggerRef = useRef(null);
  const [blurPickerOpen, setBlurPickerOpen] = useState(false);
  const [barStyleMenuOpen, setBarStyleMenuOpen] = useState(false);
  const [barColorPickerOpen, setBarColorPickerOpen] = useState(false);
  const [barStyleMenuPos, setBarStyleMenuPos] = useState(null);
  const barStyleMenuRef = useRef(null);
  const barStyleTriggerRef = useRef(null);
  const barStyleMenuElRef = useRef(null);
  const blurTabRef = useRef(null);
  const tattooTabRef = useRef(null);
  const toolbarBodyRef = useRef(null);
  const applyBtnRef = useRef(null);

  const isMobile = /Mobi|Android/i.test(navigator.userAgent);

  const COACH_STEPS = [
    { targetRef: tattooTabRef, position: 'top', title: 'Two editing modes', body: 'Use Blur to hide faces, or Tattoo Removal to paint over tattoos. Switch between them using these tabs.' },
    { targetRef: canvasContainerRef, position: 'bottom', title: 'Paint on the canvas', body: isMobile
      ? 'Use your finger to paint over areas to protect. Pinch to zoom, two fingers to pan.'
      : 'Use your mouse to paint over areas to protect. Scroll to zoom, click and drag to pan.' },
    { targetRef: toolbarBodyRef, position: 'top', title: 'Adjust your tools', body: 'Change brush size, switch tools, and undo mistakes. Controls change based on which tab is active.' },
    { targetRef: applyBtnRef, position: 'bottom', title: 'Apply when ready', body: 'Tap Apply to process your image. You can always come back to touch up later.' },
  ];
  const coachMarks = useCoachMarks('maskEdit', COACH_STEPS.length, { skip: !!editorReturnMode });

  // Single source of truth for the active editing mode.
  // - `category` is one of 'tattoo' | 'blur'
  // - `blurSubMode` is the sub-tool when category === 'blur'
  // The previous `editorMode` derived value has been removed; check
  // `category === 'tattoo'` directly so there's only one concept to keep
  // in sync.
  // Default category is Blur so first-time users land on the more common
  // privacy action (face blur) rather than the paid-feature tattoo tool.
  // When the user arrives from Review via Touch Up, `editorReturnMode` is
  // set to whichever tab they were last on so their context is preserved.
  const [category, setCategory] = useState(editorReturnMode === 'faceblur' ? 'blur' : (editorReturnMode || 'blur'));
  const [blurSubMode, setBlurSubMode] = useState('autoface');
  useEffect(() => { if (editorReturnMode) setEditorReturnMode(null); }, [editorReturnMode, setEditorReturnMode]);

  // Face blur painting state
  const [faceBlurTool, setFaceBlurTool] = useState('brush');
  const [faceBlurBrushSize, setFaceBlurBrushSize] = useState(40);
  const faceBlurToolRef = useRef('brush');
  const faceBlurBrushSizeRef = useRef(40);
  const faceBlurPaintingRef = useRef(false);
  const faceBlurLastPosRef = useRef(null);
  const editDetsRef = useRef([]);
  const featherRef = useRef(feather);
  const blurPreviewRef = useRef(null);
  const blurSettingsRef = useRef(blurSettings);
  useEffect(() => { faceBlurToolRef.current = faceBlurTool; }, [faceBlurTool]);
  useEffect(() => { faceBlurBrushSizeRef.current = faceBlurBrushSize; }, [faceBlurBrushSize]);
  useEffect(() => { editDetsRef.current = editDets; }, [editDets]);
  useEffect(() => { featherRef.current = feather; }, [feather]);
  useEffect(() => { blurSettingsRef.current = blurSettings; }, [blurSettings]);
  useEffect(() => {
    if (selectedOvalIdx !== null && selectedOvalIdx >= editDets.length) {
      setSelectedOvalIdx(null);
    }
  }, [editDets.length, selectedOvalIdx]);

  // Auto/Shape always need a real blur type for their blur objects. Freehand's
  // "Colors" brush sets mode 'none'; normalise back to gaussian when leaving it.
  useEffect(() => {
    if ((blurSubMode === 'autoface' || blurSubMode === 'shape') && blurSettings.mode === 'none') {
      setBlurSettings(s => ({ ...s, mode: 'gaussian' }));
    }
  }, [blurSubMode, blurSettings.mode, setBlurSettings]);

  const maskColor = [255, 80, 80];
  const forceRender = useCallback(() => setRenderKey(k => k + 1), []);

  const imgW = strippedCanvasRef.current?.width || 1;
  const imgH = strippedCanvasRef.current?.height || 1;

  const {
    scale, isPanning, getTransformStyle, screenToImage,
    handleTouchStart, handleTouchMove, handleTouchEnd, resetZoom,
  } = useZoomPan(imgW, imgH, canvasContainerRef);

  const {
    activeTool, setActiveTool,
    brushSize, setBrushSize,
    canUndo, canRedo,
    undoCount, redoCount,
    undo, redo,
    clearMask,
    initHistory,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
  } = useMaskEditor(tattooMaskCanvasRef, samScaleRef, imgW, imgH, detections, forceRender, screenToImage);

  // Close any open popovers on outside click. A single listener dispatches to
  // each open popover so the two can't race each other — e.g. clicking inside
  // the picker no longer leaves the dropdown listener attached.
  useEffect(() => {
    if (!blurDropdownOpen && !blurPickerOpen && !barStyleMenuOpen) return;
    const onClick = (e) => {
      if (blurDropdownOpen && blurDropdownRef.current && !blurDropdownRef.current.contains(e.target)) {
        setBlurDropdownOpen(false);
      }
      if (blurPickerOpen && blurTabRef.current && !blurTabRef.current.contains(e.target)) {
        setBlurPickerOpen(false);
      }
      if (barStyleMenuOpen
          && barStyleMenuRef.current && !barStyleMenuRef.current.contains(e.target)
          && (!barStyleMenuElRef.current || !barStyleMenuElRef.current.contains(e.target))) {
        setBarStyleMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onClick);
    return () => document.removeEventListener('pointerdown', onClick);
  }, [blurDropdownOpen, blurPickerOpen, barStyleMenuOpen]);

  // Lock body scroll
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Check ComfyUI connectivity
  useEffect(() => {
    testConnection().then(setComfyConnected).catch(() => setComfyConnected(false));
  }, []);

  // Initialize tattoo mask canvas + face blur canvas. Read dimensions directly
  // from strippedCanvasRef inside the effect rather than the imgW/imgH closure
  // values (which fall back to 1x1 if the ref was briefly null at render time).
  // Mount-only init: deps are intentionally empty — re-running would wipe the
  // user's history.
  useEffect(() => {
    const src = strippedCanvasRef.current;
    if (!src || !src.width || !src.height) return;
    if (!tattooMaskCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      tattooMaskCanvasRef.current = c;
    }
    if (!faceBlurCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      faceBlurCanvasRef.current = c;
    }
    initHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-detect faces toggle
  const handleAutoDetect = useCallback(() => {
    const faceDets = detections.filter(d => d.type !== 'tattoo').map(d => ({
      ...d,
      kind: 'blur',
      origHw: (d.bottomRight[0] - d.topLeft[0]) / 2,
      origHh: (d.bottomRight[1] - d.topLeft[1]) / 2,
    }));
    if (faceDets.length > 0) {
      setEditDets(prev => {
        const existing = new Set(prev.map(d => `${d.topLeft[0]},${d.topLeft[1]}`));
        const newDets = faceDets.filter(d => !existing.has(`${d.topLeft[0]},${d.topLeft[1]}`));
        return newDets.length > 0 ? [...prev, ...newDets] : prev;
      });
      track('face_auto_detect', { count: faceDets.length });
    }
  }, [detections]);

  // True if any pixel in the mask canvas has non-zero alpha.
  const maskHasPixels = useCallback((mask) => {
    const d = mask.getContext('2d').getImageData(0, 0, mask.width, mask.height).data;
    for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) return true; }
    return false;
  }, []);

  // --- Blur preview for face blur mode ---
  const buildPreviewMask = useCallback((dets, mode) => {
    const src = strippedCanvasRef.current;
    if (!src) return null;
    const { width, height } = src;
    const mask = document.createElement('canvas');
    mask.width = width;
    mask.height = height;
    const ctx = mask.getContext('2d');

    if (mode !== 'blackbar') {
      for (const det of dets) {
        if (det.kind === 'sticker') continue; // stickers aren't blur regions
        ctx.fillStyle = 'white';
        const cx = (det.topLeft[0] + det.bottomRight[0]) / 2;
        const cy = (det.topLeft[1] + det.bottomRight[1]) / 2;
        const rx = (det.bottomRight[0] - det.topLeft[0]) / 2 * 1.1;
        const ry = (det.bottomRight[1] - det.topLeft[1]) / 2 * 1.1;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (faceBlurCanvasRef.current) {
      ctx.drawImage(faceBlurCanvasRef.current, 0, 0);
    }

    const fr = featherRef.current;
    if (fr > 0 && mode !== 'blackbar') {
      const imgData = ctx.getImageData(0, 0, width, height);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = d[i + 3]; d[i + 1] = d[i + 3]; d[i + 2] = d[i + 3];
      }
      stackBlur(imgData, fr);
      for (let i = 0; i < d.length; i += 4) {
        d[i + 3] = d[i]; d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      }
      ctx.putImageData(imgData, 0, 0);
    }

    return mask;
  }, [strippedCanvasRef, faceBlurCanvasRef]);

  const updateBlurPreview = useCallback(() => {
    const src = strippedCanvasRef.current;
    if (!src) return;
    const dets = editDetsRef.current;
    const bs = blurSettingsRef.current;
    const { mode, strength } = bs;
    const stickerEnabled = !!bs.stickerEnabled; // freehand color-brush flag
    const wantBlur = mode === 'gaussian' || mode === 'pixelate';

    // Two object kinds: blur-kind regions feed the blur mask; sticker-kind
    // objects are stamped (each with its own params) in the engine.
    const blurDets = dets.filter(d => d.kind !== 'sticker');
    const stickerObjects = dets.filter(d => d.kind === 'sticker');

    const blurMask = wantBlur ? buildPreviewMask(blurDets, 'gaussian') : null;
    // Freehand color strokes only (an empty det list keeps just the brush canvas).
    const freehandStickerMask = stickerEnabled ? buildPreviewMask([], 'blackbar') : null;

    const hasBlur = !!blurMask && maskHasPixels(blurMask);
    const hasSticker = stickerObjects.length > 0 || (!!freehandStickerMask && maskHasPixels(freehandStickerMask));

    if (!hasBlur && !hasSticker) {
      blurPreviewRef.current = null;
    } else {
      blurPreviewRef.current = applyMaskedBlur(
        src, blurMask, wantBlur ? mode : 'none', strength,
        stickerObjects, freehandStickerMask, bs.barColor || '#000000',
      );
    }
  }, [strippedCanvasRef, buildPreviewMask]);

  const scheduleBlurPreview = useCallback(() => {
    if (blurRafRef.current) return;
    blurRafRef.current = requestAnimationFrame(() => {
      blurRafRef.current = null;
      if (!mountedRef.current) return;
      updateBlurPreview();
      forceRender();
    });
  }, [updateBlurPreview, forceRender]);

  // Trigger blur preview on relevant changes (always, regardless of active tab)
  useEffect(() => {
    scheduleBlurPreview();
  }, [editDets, blurSettings, feather]);

  // --- Render display ---
  // Reusable offscreen canvas for tinting the tattoo mask overlay. Allocated
  // once and resized on demand so we don't thrash the allocator on every
  // stroke.
  const tintedMaskRef = useRef(null);

  const renderDisplay = useCallback(() => {
    const display = displayRef.current;
    const src = strippedCanvasRef.current;
    if (!display || !src) return;

    // Only resize the backing store when the dimensions actually change.
    // Assigning canvas.width/height reallocates and zero-fills the entire
    // buffer (~48 MB at 12 MP, ~96 MB at 24 MP); doing it on every pointer-move
    // frame was a primary cause of paint lag on large images. The image is
    // fully repainted below, so skipping the reset leaves no stale pixels.
    if (display.width !== imgW || display.height !== imgH) {
      display.width = imgW;
      display.height = imgH;
    }
    const ctx = display.getContext('2d');

    // Show blur preview as base if available, otherwise raw image
    if (blurPreviewRef.current) {
      ctx.drawImage(blurPreviewRef.current, 0, 0);
    } else {
      ctx.drawImage(src, 0, 0);
    }

    const tattoos = detections.filter(d => d.type === 'tattoo');
    if (tattoos.length > 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 170, 0, 0.5)';
      ctx.lineWidth = Math.max(1, Math.round(imgW / 400));
      ctx.setLineDash([8, 5]);
      tattoos.forEach(det => {
        const x = det.topLeft[0], y = det.topLeft[1];
        const w = det.bottomRight[0] - x, h = det.bottomRight[1] - y;
        ctx.strokeRect(x, y, w, h);
      });
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Tattoo mask overlay. Previously walked every pixel in JS
    // (~4MB pixel loop per stroke at 1MP) — now uses GPU-accelerated
    // composite ops via an offscreen tinting canvas.
    const maskSrc = tattooMaskCanvasRef.current;
    if (maskSrc) {
      // Colored overlay: tint the mask with maskColor, then blit it over the
      // image with alpha. 'source-in' recolors only the alpha-hit pixels, so
      // transparency in the mask is preserved naturally.
      const tinted = tintedMaskRef.current || document.createElement('canvas');
      tintedMaskRef.current = tinted;
      // Same guard — only reallocate the tint buffer on a real size change.
      // The clearRect below handles per-frame clearing, so this is what the
      // "allocated once… don't thrash the allocator" comment above intended.
      if (tinted.width !== imgW || tinted.height !== imgH) {
        tinted.width = imgW;
        tinted.height = imgH;
      }
      const tCtx = tinted.getContext('2d');
      tCtx.clearRect(0, 0, imgW, imgH);
      tCtx.drawImage(maskSrc, 0, 0);
      tCtx.globalCompositeOperation = 'source-in';
      tCtx.fillStyle = `rgb(${maskColor[0]}, ${maskColor[1]}, ${maskColor[2]})`;
      tCtx.fillRect(0, 0, imgW, imgH);
      tCtx.globalCompositeOperation = 'source-over';
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.drawImage(tinted, 0, 0);
      ctx.restore();
    }
  }, [imgW, imgH, strippedCanvasRef, tattooMaskCanvasRef, detections, maskColor]);

  // rAF-coalesce render requests so rapid pointer events don't queue multiple
  // full repaints within a single frame.
  const renderRafRef = useRef(null);
  useEffect(() => {
    if (renderRafRef.current != null) return;
    renderRafRef.current = requestAnimationFrame(() => {
      renderRafRef.current = null;
      renderDisplay();
    });
    return () => {
      if (renderRafRef.current != null) {
        cancelAnimationFrame(renderRafRef.current);
        renderRafRef.current = null;
      }
    };
  }, [renderDisplay, renderKey]);

  // --- Tattoo mask stroke handlers ---
  const drawingRef = useRef(false);
  const touchDelayRef = useRef(null);
  useEffect(() => () => clearTimeout(touchDelayRef.current), []);

  const startStroke = useCallback((e) => {
    drawingRef.current = true;
    const pointerType = e.pointerType || 'mouse';
    setCursorPos({ x: e.clientX, y: e.clientY });
    handlePointerDown(e, displayRef.current);
    forceRender();

    const onGlobalMove = (ev) => {
      if (!drawingRef.current || isPanning.current) return;
      handlePointerMove(ev, displayRef.current);
      setCursorPos({ x: ev.clientX, y: ev.clientY });
      forceRender();
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onGlobalMove);
      window.removeEventListener('pointerup', onGlobalUp);
      globalListenersRef.current = globalListenersRef.current.filter(fn => fn !== cleanup);
    };
    const onGlobalUp = () => {
      if (drawingRef.current) { handlePointerUp(); tattooMaskDirtyRef.current = true; forceRender(); }
      drawingRef.current = false;
      if (pointerType === 'touch') setCursorPos(null);
      cleanup();
    };
    window.addEventListener('pointermove', onGlobalMove);
    window.addEventListener('pointerup', onGlobalUp);
    globalListenersRef.current.push(cleanup);
  }, [isPanning, handlePointerDown, handlePointerMove, handlePointerUp, forceRender]);

  const onTattooDown = useCallback((e) => {
    if (isPanning.current) return;
    e.preventDefault();
    if (e.pointerType === 'touch') {
      const savedEvent = { clientX: e.clientX, clientY: e.clientY, pressure: e.pressure, pointerType: e.pointerType };
      clearTimeout(touchDelayRef.current);
      touchDelayRef.current = setTimeout(() => {
        if (!isPanning.current) startStroke(savedEvent);
      }, 50);
      return;
    }
    startStroke(e);
  }, [isPanning, startStroke]);

  // --- Face blur stroke handlers ---
  const paintBlurStroke = useCallback((from, to) => {
    const canvas = faceBlurCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = faceBlurBrushSizeRef.current;

    ctx.lineWidth = size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (faceBlurToolRef.current === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'white';
    }

    ctx.beginPath();
    if (from) {
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
    } else {
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x + 0.1, to.y + 0.1);
    }
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }, [faceBlurCanvasRef]);

  const startBlurStroke = useCallback((e) => {
    faceBlurPaintingRef.current = true;
    setCursorPos({ x: e.clientX, y: e.clientY });
    const pt = screenToImage(e.clientX, e.clientY, displayRef.current);
    faceBlurLastPosRef.current = pt;
    paintBlurStroke(null, pt);
    scheduleBlurPreview();

    const pointerType = e.pointerType || 'mouse';
    const onMove = (ev) => {
      if (!faceBlurPaintingRef.current || isPanning.current) return;
      ev.preventDefault();
      const pt2 = screenToImage(ev.clientX, ev.clientY, displayRef.current);
      paintBlurStroke(faceBlurLastPosRef.current, pt2);
      faceBlurLastPosRef.current = pt2;
      setCursorPos({ x: ev.clientX, y: ev.clientY });
      scheduleBlurPreview();
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      globalListenersRef.current = globalListenersRef.current.filter(fn => fn !== cleanup);
    };
    const onUp = () => {
      faceBlurPaintingRef.current = false;
      faceBlurLastPosRef.current = null;
      if (pointerType === 'touch') setCursorPos(null);
      scheduleBlurPreview();
      cleanup();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    globalListenersRef.current.push(cleanup);
  }, [screenToImage, isPanning, paintBlurStroke, forceRender, scheduleBlurPreview]);

  const onFaceBlurDown = useCallback((e) => {
    if (isPanning.current) return;
    e.preventDefault();
    setSelectedOvalIdx(null);
    if (e.pointerType === 'touch') {
      const savedEvent = { clientX: e.clientX, clientY: e.clientY, pressure: e.pressure, pointerType: e.pointerType };
      clearTimeout(touchDelayRef.current);
      touchDelayRef.current = setTimeout(() => {
        if (!isPanning.current) startBlurStroke(savedEvent);
      }, 50);
      return;
    }
    startBlurStroke(e);
  }, [isPanning, startBlurStroke]);

  // Shape mode canvas handler (deselect on background click)
  const onShapeCanvasDown = useCallback((e) => {
    if (isPanning.current) return;
    e.preventDefault();
    setSelectedOvalIdx(null);
  }, [isPanning]);

  // --- Region / object management ---
  // Blur object: an oval that blurs whatever's under it.
  const handleAddBlur = useCallback(() => {
    const hw = imgW * 0.075;
    const hh = hw * 1.3;
    const cx = imgW / 2;
    const cy = imgH / 2;
    const newDet = {
      kind: 'blur',
      topLeft: [cx - hw, cy - hh],
      bottomRight: [cx + hw, cy + hh],
      origHw: hw,
      origHh: hh,
      probability: 1,
      contour: [],
      keypoints: null,
      segData: null,
      manual: true,
    };
    setEditDets(prev => [...prev, newDet]);
    setSelectedOvalIdx(editDetsRef.current.length);
    track('blur_region_added');
  }, [imgW, imgH, setEditDets]);

  // Sticker object: a placed sticker (bar / SVG silhouette) with its own
  // style/color/size/angle, independent of any blur. Defaults pulled from the
  // current global sticker settings (the dropdown) so "Add Sticker" matches
  // what the toolbar shows.
  const handleAddSticker = useCallback(() => {
    const hw = imgW * 0.12;
    const hh = imgW * 0.035;
    const cx = imgW / 2;
    const cy = imgH / 2;
    const bs = blurSettingsRef.current;
    const newDet = {
      kind: 'sticker',
      topLeft: [cx - hw, cy - hh],
      bottomRight: [cx + hw, cy + hh],
      origHw: hw,
      origHh: hh,
      manual: true,
      barStyle: bs.barStyle || 'solid',
      barColor: bs.barColor || '#000000',
      barWidth: 100,
      barLength: 100,
      barAngle: 0,
    };
    setEditDets(prev => [...prev, newDet]);
    setSelectedOvalIdx(editDetsRef.current.length);
    track('sticker_added', { style: newDet.barStyle });
  }, [imgW, imgH, setEditDets]);

  const handleRemoveFace = useCallback((index) => {
    setEditDets(prev => prev.filter((_, i) => i !== index));
    setSelectedOvalIdx(null);
  }, [setEditDets]);

  const handleClearFaces = useCallback(() => {
    setEditDets([]);
    setSelectedOvalIdx(null);
    // Also clear freehand blur regions
    const canvas = faceBlurCanvasRef.current;
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    scheduleBlurPreview();
  }, [setEditDets, faceBlurCanvasRef, scheduleBlurPreview]);

  const handleClearBlurBrush = useCallback(() => {
    const canvas = faceBlurCanvasRef.current;
    if (!canvas) return;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    scheduleBlurPreview();
    forceRender();
  }, [faceBlurCanvasRef, forceRender, scheduleBlurPreview]);

  const handleOvalResize = useCallback((newPercent) => {
    if (selectedOvalIdx === null) return;
    const det = editDetsRef.current[selectedOvalIdx];
    if (!det || !det.origHw) return;
    const scale = newPercent / 100;
    const cx = (det.topLeft[0] + det.bottomRight[0]) / 2;
    const cy = (det.topLeft[1] + det.bottomRight[1]) / 2;
    const hw = det.origHw * scale;
    const hh = det.origHh * scale;
    const newDets = [...editDetsRef.current];
    newDets[selectedOvalIdx] = {
      ...newDets[selectedOvalIdx],
      topLeft: [cx - hw, cy - hh],
      bottomRight: [cx + hw, cy + hh],
    };
    setEditDets(newDets);
    editDetsRef.current = newDets;
    forceRender();
  }, [selectedOvalIdx, setEditDets, forceRender]);

  const handleFaceDragDown = useCallback((e, index) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedOvalIdx(index);
    const startPt = screenToImage(e.clientX, e.clientY, displayRef.current);
    const dets = editDetsRef.current;
    const origTL = [...dets[index].topLeft];
    const origBR = [...dets[index].bottomRight];

    const onMove = (ev) => {
      ev.preventDefault();
      const curPt = screenToImage(ev.clientX, ev.clientY, displayRef.current);
      const dx = curPt.x - startPt.x;
      const dy = curPt.y - startPt.y;
      setEditDets(prev => {
        const next = [...prev];
        next[index] = {
          ...next[index],
          topLeft: [origTL[0] + dx, origTL[1] + dy],
          bottomRight: [origBR[0] + dx, origBR[1] + dy],
        };
        return next;
      });
      forceRender();
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      globalListenersRef.current = globalListenersRef.current.filter(fn => fn !== cleanup);
    };
    const onUp = () => {
      cleanup();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    globalListenersRef.current.push(cleanup);
  }, [screenToImage, setEditDets, forceRender]);

  // --- Touch cancel ---
  const onContainerTouchStart = useCallback((e) => {
    if (e.touches.length >= 2) {
      clearTimeout(touchDelayRef.current);
      touchDelayRef.current = null;
      if (category === 'tattoo') {
        if (drawingRef.current) {
          drawingRef.current = false;
          handlePointerUp();
          undo();
          forceRender();
        }
      } else {
        faceBlurPaintingRef.current = false;
      }
    }
    handleTouchStart(e);
  }, [handleTouchStart, handlePointerUp, undo, forceRender, category]);

  // --- Apply & Skip ---
  const handleApply = useCallback(async () => {
    // Fast path: if the tattoo mask has never been painted on, hasTattoo is
    // definitely false and we skip the ~W×H pixel scan. At Original tier
    // (multi-MP) this saves 150-300ms on every face-blur-only Apply, which
    // is by far the most common path. We only fall back to the full scan
    // when the dirty ref is true (the user painted something), because an
    // erase-to-empty leaves the ref true but the pixels gone.
    const hasTattoo = (() => {
      if (!tattooMaskDirtyRef?.current) return false;
      const m = tattooMaskCanvasRef.current;
      if (!m) return false;
      const d = m.getContext('2d').getImageData(0, 0, m.width, m.height).data;
      for (let i = 3; i < d.length; i += 4) { if (d[i] > 128) return true; }
      return false;
    })();

    // Entitlement gate (free users only — premium bypasses all ad + credit logic).
    if (!premium) {
      // Tattoo removal consumes a weekly credit; block + paywall if depleted.
      // Skip the credit check entirely when the current pipeline session has
      // already claimed one — re-touching the same photo must not re-charge.
      const needsNewCredit = hasTattoo && !tattooCreditClaimedRef?.current;
      if (needsNewCredit && !canConsumeCredit()) {
        track('subscription_gated', { surface: 'tattoo_credit' });
        setShowPaywall(true);
        return;
      }
      // Interstitial on the 2nd+ Apply of this session. First Apply is free
      // of ads so users aren't hit immediately on their first interaction.
      const prior = Number(sessionStorage.getItem('ih_apply_count_session') || 0);
      if (prior >= 1) {
        import('../utils/clickadillaAd').then((m) => {
          try { m.showClickadillaInterstitial?.(); } catch { /* non-blocking */ }
        });
      }
      try { sessionStorage.setItem('ih_apply_count_session', String(prior + 1)); } catch {}
    }

    track('apply_clicked', { has_tattoo_mask: hasTattoo, face_regions: editDetsRef.current.length, premium });
    setApplying(true);
    setApplyStatus('Preparing...');
    setApplyProgress(0);
    setApplyError(null);
    setElapsed(0);
    const t0 = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    abortRef.current = new AbortController();
    try {
      // Pass null when we already know the mask is empty — that skips
      // recompositeWithCustomMask's own O(W×H) scan (it only runs on a
      // truthy customTattooMask). When hasTattoo is true we pass the
      // canvas and let the pipeline do its normal check.
      const maskArg = hasTattoo ? tattooMaskCanvasRef.current : null;
      await recompositeWithCustomMask(maskArg, {
        // Painted face regions are applied downstream in ReviewScreen, not
        // here — skip the BlazeFace auto-pass to avoid double-blurring.
        faceAutoBlur: false,
        signal: abortRef.current.signal,
        onProgress: (p) => {
          if (typeof p === 'string') { setApplyStatus(p); }
          else { setApplyStatus(p.message); setApplyProgress(p.fraction); }
        },
      });
      clearInterval(timerRef.current);
      // Credit consumption happens HERE (after successful queue+result) so a
      // network error, user-abort, or retouch-of-already-paid-photo doesn't
      // burn a credit. The per-session flag gates re-Apply within the same
      // pipeline session to a single charge.
      if (!premium && hasTattoo && !tattooCreditClaimedRef?.current) {
        consumeCredit();
        if (tattooCreditClaimedRef) tattooCreditClaimedRef.current = true;
        syncCreditState();
        track('credit_consumed');
      }
      tattooMaskDirtyRef.current = false;
      setScreen('review');
    } catch (err) {
      clearInterval(timerRef.current);
      console.error('Apply failed:', err);
      // Classify the error so the message tells the user what to actually do.
      const raw = (err?.message || '').toString();
      const lower = raw.toLowerCase();
      let friendly;
      if (err?.name === 'AbortError' || lower.includes('cancel') || lower.includes('aborted')) {
        friendly = 'Cancelled.';
      } else if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('network')) {
        friendly = 'Network error — check your connection and try again.';
      } else if (lower.includes('upload failed')) {
        friendly = `Upload to processing server failed (${raw}). Try again in a moment.`;
      } else if (lower.includes('queue failed')) {
        friendly = `Processing server rejected the job (${raw}). Try again in a moment.`;
      } else if (lower.includes('comfyui') || lower.includes('execution') || lower.includes('workflow')) {
        friendly = `Processing server error: ${raw}. Try again, or use Skip to bypass tattoo removal.`;
      } else if (lower.includes('history') || lower.includes('timed out') || lower.includes('timeout')) {
        friendly = 'Processing server timed out. Try again, or use Skip to bypass tattoo removal.';
      } else if (lower.includes('download')) {
        friendly = 'Failed to download the result. Check your connection and try again.';
      } else {
        friendly = `Processing failed: ${raw || 'unknown error'}.`;
      }
      setApplyError(friendly);
      setApplying(false);
    }
  }, [recompositeWithCustomMask, tattooMaskCanvasRef, setScreen, tattooMaskDirtyRef, tattooCreditClaimedRef, premium, syncCreditState]);

  const handleSkip = useCallback(() => {
    track('skip_clicked');
    const src = strippedCanvasRef.current;
    if (src && !inpaintedCanvasRef.current) {
      const base = document.createElement('canvas');
      base.width = src.width;
      base.height = src.height;
      base.getContext('2d').drawImage(src, 0, 0);
      inpaintedCanvasRef.current = base;

      const out = document.createElement('canvas');
      out.width = src.width;
      out.height = src.height;
      out.getContext('2d').drawImage(src, 0, 0);
      outputCanvasRef.current = out;
    }
    setScreen('review');
  }, [setScreen, strippedCanvasRef, inpaintedCanvasRef, outputCanvasRef]);

  // --- Keyboard shortcuts ---
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
        e.preventDefault();
        if (category === 'tattoo') { undo(); tattooMaskDirtyRef.current = true; forceRender(); }
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z') || (e.shiftKey && e.key === 'Z'))) {
        e.preventDefault();
        if (category === 'tattoo') { redo(); tattooMaskDirtyRef.current = true; forceRender(); }
      }
      if (e.key === 'Enter' || ((e.ctrlKey || e.metaKey) && e.key === 's')) {
        e.preventDefault();
        if (!applying) handleApply();
      }
      if (e.key === '[') {
        if (category === 'tattoo') setBrushSize(s => Math.max(5, s - 10));
        else setFaceBlurBrushSize(s => Math.max(10, s - 10));
      }
      if (e.key === ']') {
        if (category === 'tattoo') setBrushSize(s => Math.min(200, s + 10));
        else setFaceBlurBrushSize(s => Math.min(150, s + 10));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo, forceRender, applying, handleApply, setBrushSize, category]);

  const showBrushCursor = category === 'tattoo' || (category === 'blur' && blurSubMode === 'freehand');
  const currentBrushSize = category === 'tattoo' ? brushSize : faceBlurBrushSize;
  // Cursor color now lives in CSS (var(--accent)) so it stays in sync with the
  // theme. The eraser variant just adds a modifier class that switches to a
  // dotted border — no hard-coded hex needed.
  const isEraserActive = category === 'tattoo'
    ? activeTool === 'eraser'
    : faceBlurTool === 'eraser';
  const cursorClass = `brush-cursor${isEraserActive ? ' brush-cursor--eraser' : ''}`;

  // --- Progress & error overlays ---
  const handleCancelApply = useCallback(() => {
    abortRef.current?.abort();
    clearInterval(timerRef.current);
    setApplying(false);
    setApplyStatus('');
    setApplyProgress(0);
  }, []);

  const progressOverlay = applying ? (
    <ProgressOverlay progress={applyProgress} elapsed={elapsed} onCancel={handleCancelApply} showTips={premium} />
  ) : null;

  const errorOverlay = applyError ? (
    <ErrorOverlay
      error={applyError}
      onRetry={() => { setApplyError(null); handleApply(); }}
      onSkip={() => { setApplyError(null); handleSkip(); }}
      onDismiss={() => setApplyError(null)}
    />
  ) : null;

  const selectedOvalScale = selectedOvalIdx !== null && editDets[selectedOvalIdx]?.origHw
    ? Math.round(((editDets[selectedOvalIdx].bottomRight[0] - editDets[selectedOvalIdx].topLeft[0]) / 2) / editDets[selectedOvalIdx].origHw * 100)
    : 100;

  // Smart primary action: skip ComfyUI when mask unchanged or when it's down
  const handlePrimaryAction = useCallback(() => {
    // If tattoo mask hasn't changed and we already have an inpainted result, skip ComfyUI
    if (!tattooMaskDirtyRef.current && inpaintedCanvasRef.current) {
      handleSkip();
      return;
    }
    if (comfyConnected === false) {
      const m = tattooMaskCanvasRef.current;
      const hasTattoo = m && (() => {
        const d = m.getContext('2d').getImageData(0, 0, m.width, m.height).data;
        for (let i = 3; i < d.length; i += 4) { if (d[i] > 128) return true; }
        return false;
      })();
      if (!hasTattoo) { handleSkip(); return; }
      // Fire ad even when ComfyUI is down — the user intended to process
      import('../utils/clickadillaAd').then((m) => {
        try { m.showClickadillaInterstitial?.(); } catch { /* non-blocking */ }
      });
      // Server down but user has a tattoo mask — confirm before discarding it
      setShowOfflineConfirm(true);
      return;
    }
    handleApply();
  }, [comfyConnected, handleApply, handleSkip, tattooMaskCanvasRef, tattooMaskDirtyRef, inpaintedCanvasRef]);

  // Blur-style selector — 3 segmented buttons (Gaussian / Pixelate / Bar).
  // The "Bar" segment is itself a dropdown showing the active bar style
  // (e.g. "Marker ▾") when bar mode is selected. Tapping it toggles a
  // popover of 5 style options. When bar mode is active, an inline color
  // picker appears next to the segmented control.
  // Blur type + current-sticker selector. Gaussian / Pixelate pick the blur
  // TYPE (always one active in Auto/Shape — blur on/off is now per blur object).
  // The Stickers dropdown picks the style/color of the SELECTED sticker, or the
  // default for the next "Add Sticker" when nothing is selected. Freehand keeps
  // its exclusive brush picker (Gaussian / Pixelate / Colors).
  const isFreehand = blurSubMode === 'freehand';
  const selectedDet = selectedOvalIdx !== null ? editDets[selectedOvalIdx] : null;
  const selectedSticker = selectedDet && selectedDet.kind === 'sticker' ? selectedDet : null;
  const stickerOn = !!blurSettings.stickerEnabled; // freehand color-brush flag
  const curStickerStyle = selectedSticker ? (selectedSticker.barStyle || 'solid') : (blurSettings.barStyle || 'solid');
  const curStickerColor = selectedSticker ? (selectedSticker.barColor || '#000000') : (blurSettings.barColor || '#000000');
  const activeBarStyle = BAR_STYLES.find((s) => s.key === curStickerStyle) || BAR_STYLES[0];
  const barLabel = isFreehand ? 'Stickers' : activeBarStyle.label;

  // Apply a sticker patch to the selected sticker (if any) AND remember it as
  // the default for the next Add Sticker.
  const updateSelectedSticker = (patch) => {
    if (selectedSticker) {
      setEditDets((prev) => prev.map((d, i) => (i === selectedOvalIdx ? { ...d, ...patch } : d)));
    }
    setBlurSettings((s) => ({ ...s, ...patch }));
  };

  const blurDropdownJSX = (
    <div className="blur-style-row" role="radiogroup" aria-label="Blur style">
      {[
        { value: 'gaussian', label: 'Gaussian' },
        { value: 'pixelate', label: 'Pixelate' },
      ].map((opt) => {
        const isSelected = blurSettings.mode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            className={`blur-style-btn${isSelected ? ' is-selected' : ''}`}
            onClick={() => {
              setBarStyleMenuOpen(false);
              setBlurSettings(prev => isFreehand
                // Freehand: blur and color brush are mutually exclusive.
                ? { ...prev, mode: opt.value, stickerEnabled: false }
                // Auto/Shape: just the blur type (always one active).
                : { ...prev, mode: opt.value });
              track('blur_mode_changed', { mode: opt.value });
            }}
          >
            {opt.label}
          </button>
        );
      })}
      {/* Stickers segment. Outside Freehand it opens a dropdown to pick the
          style/color of the selected sticker (or the default for the next Add
          Sticker). In Freehand it's a direct "Colors" picker for the brush. */}
      <div className="bar-style-menu-wrap" ref={barStyleMenuRef}>
        {isFreehand ? (
          <button
            ref={barStyleTriggerRef}
            type="button"
            role="radio"
            aria-checked={stickerOn}
            className={`blur-style-btn bar-style-trigger${stickerOn ? ' is-selected' : ''}`}
            onClick={() => {
              // Freehand: choosing a color switches the painted stroke to the
              // sticker (color) effect and turns the blur off (exclusive).
              setBlurSettings((prev) => ({ ...prev, mode: 'none', stickerEnabled: true }));
              setBarColorPickerOpen(true);
            }}
          >
            <span>Colors</span>
            <span className="bar-style-trigger-swatch" style={{ background: curStickerColor }} aria-hidden="true" />
          </button>
        ) : (
          <button
            ref={barStyleTriggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={barStyleMenuOpen}
            className={`blur-style-btn bar-style-trigger${selectedSticker ? ' is-selected' : ''}`}
            onClick={() => {
              setBarStyleMenuOpen((v) => {
                const next = !v;
                if (next && barStyleTriggerRef.current) {
                  const r = barStyleTriggerRef.current.getBoundingClientRect();
                  setBarStyleMenuPos({ left: r.left, bottom: window.innerHeight - r.top + 4 });
                }
                return next;
              });
            }}
          >
            <span>{barLabel}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
        {barStyleMenuOpen && barStyleMenuPos && createPortal(
          <div
            ref={barStyleMenuElRef}
            className="bar-style-menu"
            role="menu"
            aria-label="Sticker style"
            style={{ left: barStyleMenuPos.left, bottom: barStyleMenuPos.bottom }}
          >
            <button
              type="button"
              role="menuitem"
              className="bar-style-menu-item bar-style-menu-color"
              onClick={() => {
                setBarStyleMenuOpen(false);
                setBarColorPickerOpen(true);
              }}
            >
              <span className="bar-style-menu-swatch" style={{ background: curStickerColor }} aria-hidden="true" />
              <span>Color…</span>
            </button>
            <div className="bar-style-menu-divider" role="separator" />
            {BAR_STYLES.map((s) => {
              const sel = curStickerStyle === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={sel}
                  className={`bar-style-menu-item${sel ? ' is-active' : ''}`}
                  onClick={() => {
                    updateSelectedSticker({ barStyle: s.key });
                    setBarStyleMenuOpen(false);
                    track('sticker_changed', { barStyle: s.key });
                  }}
                >
                  {s.label}
                </button>
              );
            })}
          </div>,
          document.body
        )}
      </div>
    </div>
  );

  // Blur sliders (Strength + Feather) show when a blur layer is active; the
  // sticker sliders (Width / Length / Angle) show when stickers are on. Both
  // sets can appear together when blur + stickers are combined.
  const wantBlurControls = blurSettings.mode === 'gaussian' || blurSettings.mode === 'pixelate';
  const blurAdjustmentsRow = (
    <>
      <div className="toolbar-row">
        <div className="toolbar-group toolbar-group-dropdown">
          {blurDropdownJSX}
        </div>
        {wantBlurControls && (
          <>
            <div className="toolbar-group toolbar-group-slider">
              <label className="toolbar-slider">
                <span>Blur Strength</span>
                <input
                  type="range"
                  min="5"
                  max="60"
                  value={blurSettings.strength}
                  onChange={(e) => { setBlurSettings(prev => ({ ...prev, strength: parseInt(e.target.value, 10) }));}}
                />
              </label>
            </div>
            <div className="toolbar-group toolbar-group-slider">
              <label className="toolbar-slider">
                <span>Feather</span>
                <input
                  type="range"
                  min="0"
                  max="60"
                  value={feather}
                  onChange={(e) => { setFeather(parseInt(e.target.value, 10));}}
                />
              </label>
            </div>
          </>
        )}
      </div>
      {selectedSticker && (
        <div className="toolbar-row">
          <div className="toolbar-group toolbar-group-slider">
            <label className="toolbar-slider">
              <span>Width</span>
              <input
                type="range"
                min="10"
                max="100"
                value={selectedSticker.barWidth ?? 100}
                onChange={(e) => updateSelectedSticker({ barWidth: parseInt(e.target.value, 10) })}
              />
            </label>
          </div>
          <div className="toolbar-group toolbar-group-slider">
            <label className="toolbar-slider">
              <span>Length</span>
              <input
                type="range"
                min="10"
                max="100"
                value={selectedSticker.barLength ?? 100}
                onChange={(e) => updateSelectedSticker({ barLength: parseInt(e.target.value, 10) })}
              />
            </label>
          </div>
          <div className="toolbar-group toolbar-group-slider">
            <label className="toolbar-slider">
              <span>Angle</span>
              <input
                type="range"
                min="-45"
                max="45"
                value={selectedSticker.barAngle ?? 0}
                onChange={(e) => updateSelectedSticker({ barAngle: parseInt(e.target.value, 10) })}
              />
            </label>
          </div>
        </div>
      )}
    </>
  );

  const selectedBlurRegionRow = selectedOvalIdx !== null && editDets[selectedOvalIdx] ? (
    <div className="toolbar-row oval-resize-row">
      <div className="toolbar-group toolbar-group-inline">
        <span className="toolbar-label">
          {selectedSticker ? 'Sticker' : (blurSubMode === 'autoface' ? 'Face' : 'Blur')} {selectedOvalIdx + 1}
        </span>
      </div>
      <div className="toolbar-group toolbar-group-slider">
        <label className="toolbar-slider">
          <span>Resize</span>
          <input
            type="range"
            min="30"
            max="300"
            value={selectedOvalScale}
            onChange={(e) => { handleOvalResize(parseInt(e.target.value, 10));}}
          />
        </label>
      </div>
      <div className="toolbar-group toolbar-group-inline">
        <button
          className="tool-btn"
          onClick={() => { handleRemoveFace(selectedOvalIdx); }}
          title="Remove selected"
        >
          Remove
        </button>
      </div>
    </div>
  ) : null;

  // --- Bottom toolbar content ---
  const toolbarContent = (
    <div className="bottom-toolbar-inner mask-editor-toolbar">
      {/* Brush size slider — tattoo only; freehand has it combined with dropdown */}
      <div className="mask-editor-toolbar-body" ref={toolbarBodyRef}>
        {category === 'tattoo' && (
          <div className="toolbar-panel mask-editor-toolbar-panel">
            <h3 className="mode-panel-title">Tattoo Removal</h3>
            {!applying && (
              <div className="toolbar-row brush-size-row">
                <div className="toolbar-group toolbar-group-slider toolbar-group-fill">
                  <label className="toolbar-slider">
                    <span>Brush Size</span>
                    <input
                      type="range"
                      min={5}
                      max={200}
                      value={brushSize}
                      onChange={(e) => { setBrushSize(parseInt(e.target.value, 10));}}
                    />
                  </label>
                </div>
              </div>
            )}
            <div className="toolbar-row">
              <div className="toolbar-group toolbar-group-buttons">
                <button
                  className={`tool-btn ${activeTool === 'brush' ? 'active' : ''}`}
                  onClick={() => setActiveTool('brush')}
                  title="Paint over tattoo areas"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0 8.4-2.245c0-.399-.078-.78-.22-1.128Zm0 0a15.998 15.998 0 0 0 3.388-1.62m-5.043-.025a15.994 15.994 0 0 1 1.622-3.395m3.42 3.42a15.995 15.995 0 0 0 4.764-4.648l3.876-5.814a1.151 1.151 0 0 0-1.597-1.597L14.146 6.32a15.996 15.996 0 0 0-4.649 4.763m3.42 3.42a6.776 6.776 0 0 0-3.42-3.42" />
                  </svg>
                  Brush
                </button>
                <button
                  className={`tool-btn ${activeTool === 'eraser' ? 'active' : ''}`}
                  onClick={() => setActiveTool('eraser')}
                  title="Erase mask areas"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 20H7L3 16l9-9 8 8-4 4" />
                    <path d="M6 11l4-4" />
                  </svg>
                  Eraser
                </button>
              </div>

              <div className="toolbar-group toolbar-group-buttons">
                <button className="tool-btn" onClick={() => { undo(); tattooMaskDirtyRef.current = true; forceRender(); }} disabled={!canUndo} title="Undo" aria-label="Undo">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
                  </svg>
                  {undoCount > 0 && <span className="tool-badge">{undoCount}</span>}
                </button>
                <button className="tool-btn" onClick={() => { redo(); tattooMaskDirtyRef.current = true; forceRender(); }} disabled={!canRedo} title="Redo" aria-label="Redo">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 15l6-6m0 0-6-6m6 6H9a6 6 0 0 0 0 12h3" />
                  </svg>
                  {redoCount > 0 && <span className="tool-badge">{redoCount}</span>}
                </button>
              </div>

              <div className="toolbar-group toolbar-group-inline">
                <button className="tool-btn" onClick={() => { clearMask(); tattooMaskDirtyRef.current = true; }} title="Clear tattoo mask">
                  Clear
                </button>
              </div>
            </div>
            <div className="toolbar-hint-row">
              <span className="toolbar-hint">Paint over tattoos to mark them for removal</span>
            </div>
          </div>
        )}

      {/* Blur category */}
        {category === 'blur' && blurSubMode === 'shape' && (
          <div className="toolbar-panel mask-editor-toolbar-panel">
            <h3 className="mode-panel-title">Shape Blur</h3>
            {blurAdjustmentsRow}
            {selectedBlurRegionRow}
            <div className="toolbar-row">
              <div className="toolbar-group toolbar-group-buttons">
                <button className="tool-btn" onClick={handleAddBlur} title="Add a blur region">
                  + Add Blur
                </button>
                <button className="tool-btn" onClick={handleAddSticker} title="Add a sticker">
                  + Add Sticker
                </button>
              </div>
            </div>
          </div>
        )}

        {category === 'blur' && blurSubMode === 'autoface' && (
          <div className="toolbar-panel mask-editor-toolbar-panel">
            <h3 className="mode-panel-title">Auto Blur</h3>
            {blurAdjustmentsRow}
            {selectedBlurRegionRow}
            <div className="toolbar-row">
              <div className="toolbar-group toolbar-group-buttons">
                <button className="tool-btn" onClick={handleAutoDetect} title="Auto-detect faces in the image">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607ZM10.5 7.5v6m3-3h-6" />
                  </svg>
                  Detect Faces
                </button>
                <button className="tool-btn" onClick={handleAddSticker} title="Add a sticker">
                  + Add Sticker
                </button>
                <button className="tool-btn" onClick={handleClearFaces} title="Clear all blur regions">
                  Clear All
                </button>
              </div>
            </div>
          </div>
        )}

        {category === 'blur' && blurSubMode === 'freehand' && (
          <div className="toolbar-panel mask-editor-toolbar-panel">
            <h3 className="mode-panel-title">Freehand Blur</h3>
            <div className="toolbar-row brush-size-row">
              <div className="toolbar-group toolbar-group-dropdown">
                {blurDropdownJSX}
              </div>
              <div className="toolbar-group toolbar-group-slider">
                <label className="toolbar-slider">
                  <span>Brush Size</span>
                  <input
                    type="range"
                    min={10}
                    max={150}
                    value={faceBlurBrushSize}
                    onChange={(e) => { setFaceBlurBrushSize(parseInt(e.target.value, 10));}}
                  />
                </label>
              </div>
            </div>
            {wantBlurControls && (
              <div className="toolbar-row">
                <div className="toolbar-group toolbar-group-slider">
                  <label className="toolbar-slider">
                    <span>Blur Strength</span>
                    <input
                      type="range"
                      min="5"
                      max="60"
                      value={blurSettings.strength}
                      onChange={(e) => { setBlurSettings(prev => ({ ...prev, strength: parseInt(e.target.value, 10) }));}}
                    />
                  </label>
                </div>
                <div className="toolbar-group toolbar-group-slider">
                  <label className="toolbar-slider">
                    <span>Feather</span>
                    <input
                      type="range"
                      min="0"
                      max="60"
                      value={feather}
                      onChange={(e) => { setFeather(parseInt(e.target.value, 10));}}
                    />
                  </label>
                </div>
              </div>
            )}
            <div className="toolbar-row">
              <div className="toolbar-group toolbar-group-buttons">
                <button
                  className={`tool-btn ${faceBlurTool === 'brush' ? 'active' : ''}`}
                  onClick={() => setFaceBlurTool('brush')}
                  title="Paint blur regions freehand"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0 8.4-2.245c0-.399-.078-.78-.22-1.128Zm0 0a15.998 15.998 0 0 0 3.388-1.62m-5.043-.025a15.994 15.994 0 0 1 1.622-3.395m3.42 3.42a15.995 15.995 0 0 0 4.764-4.648l3.876-5.814a1.151 1.151 0 0 0-1.597-1.597L14.146 6.32a15.996 15.996 0 0 0-4.649 4.763m3.42 3.42a6.776 6.776 0 0 0-3.42-3.42" />
                  </svg>
                  Paint
                </button>
                <button
                  className={`tool-btn ${faceBlurTool === 'eraser' ? 'active' : ''}`}
                  onClick={() => setFaceBlurTool('eraser')}
                  title="Erase painted blur regions"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 20H7L3 16l9-9 8 8-4 4" />
                    <path d="M6 11l4-4" />
                  </svg>
                  Erase
                </button>
              </div>
              <div className="toolbar-group toolbar-group-inline">
                <button className="tool-btn" onClick={handleClearBlurBrush} title="Clear painted blur regions">
                  Clear
                </button>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* Level 1: Category tabs (bottom of toolbar).
          Blur (with sub-mode picker chevron) sits on the LEFT, Tattoo
          Removal on the RIGHT — matches the Redact.ID home artboard. */}
      <div className="toolbar-tabs">
        <div className="toolbar-tab-wrapper" ref={blurTabRef}>
          <button className={`toolbar-tab${category === 'blur' ? ' active' : ''}`}
            onClick={() => {
              if (category !== 'blur') {
                setCategory('blur');
              } else {
                setBlurPickerOpen(v => !v);
              }
            }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7.5 3.75H6A2.25 2.25 0 0 0 3.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0 1 20.25 6v1.5m0 9V18A2.25 2.25 0 0 1 18 20.25h-1.5m-9 0H6A2.25 2.25 0 0 1 3.75 18v-1.5M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            </svg>
            {{ autoface: 'Auto Blur', shape: 'Shape Blur', freehand: 'Freehand Blur' }[blurSubMode]}
            <svg className={`blur-tab-chevron${category === 'blur' ? ' active' : ''}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points={blurPickerOpen ? '6 15 12 9 18 15' : '6 9 12 15 18 9'} />
            </svg>
          </button>
          {blurPickerOpen && (
            <div className="blur-mode-picker">
              {[
                { value: 'autoface', label: 'Auto Blur', icon: (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M7.5 3.75H6A2.25 2.25 0 0 0 3.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0 1 20.25 6v1.5m0 9V18A2.25 2.25 0 0 1 18 20.25h-1.5m-9 0H6A2.25 2.25 0 0 1 3.75 18v-1.5M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                  </svg>
                )},
                { value: 'shape', label: 'Shape Blur', icon: (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="12" rx="9" ry="6"/></svg>
                )},
                { value: 'freehand', label: 'Freehand Blur', icon: (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0 8.4-2.245c0-.399-.078-.78-.22-1.128Zm0 0a15.998 15.998 0 0 0 3.388-1.62m-5.043-.025a15.994 15.994 0 0 1 1.622-3.395m3.42 3.42a15.995 15.995 0 0 0 4.764-4.648l3.876-5.814a1.151 1.151 0 0 0-1.597-1.597L14.146 6.32a15.996 15.996 0 0 0-4.649 4.763m3.42 3.42a6.776 6.776 0 0 0-3.42-3.42" />
                  </svg>
                )},
              ].map(opt => (
                <button
                  key={opt.value}
                  className={`blur-mode-picker-item${blurSubMode === opt.value ? ' active' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setBlurSubMode(opt.value);
                    setCategory('blur');
                    setBlurPickerOpen(false);
                  }}
                >
                  {opt.icon}
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button ref={tattooTabRef} className={`toolbar-tab${category === 'tattoo' ? ' active' : ''}`}
          onClick={() => { setCategory('tattoo'); setBlurPickerOpen(false); }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
          </svg>
          Tattoo Removal
        </button>
      </div>
    </div>
  );

  return (
    <ScreenShell
      contentClassName="mask-editor-screen"
      stepLabel="Editing"
      backAction={() => setShowConfirm(true)}
      backLabel="Back"
      primaryAction={applying ? undefined : handlePrimaryAction}
      primaryLabel="Apply"
      primaryDisabled={applying}
      primaryRef={applyBtnRef}
      toolbarClassName="screen-bottom-toolbar--mask-editor"
      toolbar={toolbarContent}
    >
      {comfyConnected === false && !comfyBannerDismissed && (
        <div className="comfy-warning-banner">
          <span>Tattoo removal server unavailable — face blur and metadata stripping still work. Press Apply to proceed.</span>
          <button className="comfy-warning-dismiss" onClick={() => setComfyBannerDismissed(true)} aria-label="Dismiss">&times;</button>
        </div>
      )}

      <div
        ref={canvasContainerRef}
        className="mask-editor-canvas-container"
        onTouchStart={onContainerTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onMouseMove={(e) => setCursorPos({ x: e.clientX, y: e.clientY })}
        onMouseLeave={() => setCursorPos(null)}
      >
        {progressOverlay}
        {errorOverlay}
        <div
          className="mask-editor-zoom-wrapper"
          style={{ transform: getTransformStyle(), transformOrigin: 'center center' }}
        >
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <canvas
              ref={displayRef}
              className="mask-editor-canvas"
              aria-label="Mask editor canvas"
              style={{ cursor: showBrushCursor ? 'none' : undefined, touchAction: 'none' }}
              onPointerDown={category === 'tattoo' ? onTattooDown : (blurSubMode === 'freehand' ? onFaceBlurDown : onShapeCanvasDown)}
            />
            {editDets.map((det, i) => (
              <div
                key={`face-${i}`}
                className={`face-overlay${selectedOvalIdx === i ? ' selected' : ''}${det.kind === 'sticker' ? ' sticker-overlay' : ''}`}
                style={{
                  position: 'absolute',
                  left: `${(det.topLeft[0] / imgW) * 100}%`,
                  top: `${(det.topLeft[1] / imgH) * 100}%`,
                  width: `${((det.bottomRight[0] - det.topLeft[0]) / imgW) * 100}%`,
                  height: `${((det.bottomRight[1] - det.topLeft[1]) / imgH) * 100}%`,
                  pointerEvents: category === 'blur' ? 'auto' : 'none',
                }}
                onPointerDown={category === 'blur' ? (e) => handleFaceDragDown(e, i) : undefined}
              >
                {category === 'blur' && (
                  <svg className="face-overlay-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="5 9 2 12 5 15" />
                    <polyline points="9 5 12 2 15 5" />
                    <polyline points="15 19 12 22 9 19" />
                    <polyline points="19 9 22 12 19 15" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <line x1="12" y1="2" x2="12" y2="22" />
                  </svg>
                )}
                {category === 'blur' && (
                  <button
                    className="face-overlay-remove"
                    onClick={(e) => { e.stopPropagation(); handleRemoveFace(i); }}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                      <line x1="4" y1="4" x2="20" y2="20" />
                      <line x1="20" y1="4" x2="4" y2="20" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
        <InsetZoom
          displayCanvasRef={displayRef}
          cursorPos={cursorPos}
          imageWidth={imgW}
          imageHeight={imgH}
          screenToImage={screenToImage}
        />
        {showBrushCursor && !applying && (() => {
          const el = displayRef.current;
          const rect = el?.getBoundingClientRect();
          const pixelRatio = rect ? rect.width / imgW : 1;
          const size = currentBrushSize * pixelRatio;
          if (cursorPos) {
            return (
              <div
                className={cursorClass}
                style={{ width: size, height: size, left: cursorPos.x, top: cursorPos.y }}
              />
            );
          }
          if (rect) {
            return (
              <div
                className={`${cursorClass} brush-cursor-preview`}
                style={{ width: size, height: size, left: rect.left + rect.width / 2, top: rect.top + rect.height / 2 }}
              />
            );
          }
          return null;
        })()}
      </div>

      {showConfirm && (
        <ConfirmModal
          message={canUndo
            ? 'Go back? Your current mask work will be lost.'
            : 'Go back and upload a different image?'}
          confirmLabel={canUndo ? 'Discard & Start Over' : 'Start Over'}
          confirmVariant={canUndo ? 'danger' : 'primary'}
          onConfirm={() => { track('start_over', { from: 'mask-edit' }); reset(); }}
          onCancel={() => setShowConfirm(false)}
        />
      )}

      {showOfflineConfirm && (
        <ConfirmModal
          message="Tattoo removal server is unavailable. Continue without tattoo removal? Face blur and metadata stripping will still be applied."
          confirmLabel="Continue Without It"
          confirmVariant="primary"
          onConfirm={() => { setShowOfflineConfirm(false); handleSkip(); }}
          onCancel={() => setShowOfflineConfirm(false)}
        />
      )}

      {coachMarks.isActive && COACH_STEPS[coachMarks.activeStep] && (
        <CoachMark
          {...COACH_STEPS[coachMarks.activeStep]}
          stepIndex={coachMarks.activeStep}
          totalSteps={coachMarks.totalSteps}
          screenKey="maskEdit"
          onNext={coachMarks.next}
          onDismiss={coachMarks.dismiss}
          onDismissAll={() => { suppressAllWalkthroughs(); coachMarks.dismiss(); }}
        />
      )}

      {showPaywall && (
        <PaywallModal
          onClose={() => setShowPaywall(false)}
          onEarnedCredit={() => {
            syncCreditState();
            setShowPaywall(false);
            // Re-trigger the Apply the user was blocked from — they already
            // had a mask ready when the paywall popped.
            handleApply();
          }}
          onRedeemClick={() => {
            setShowPaywall(false);
            setShowRedeem(true);
          }}
        />
      )}

      {showRedeem && (
        <RedeemCodeModal
          onClose={() => setShowRedeem(false)}
          onSuccess={() => setShowRedeem(false)}
        />
      )}

      <ColorSpectrumPicker
        open={barColorPickerOpen}
        value={curStickerColor}
        onChange={(hex) => updateSelectedSticker({ barColor: hex })}
        onClose={() => setBarColorPickerOpen(false)}
        ariaLabel="Sticker color"
      />
    </ScreenShell>
  );
}
