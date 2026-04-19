import { useRef, useEffect, useCallback, useState } from 'react';
import { usePipeline } from '../context/PipelineContext';
import { useMaskEditor } from '../hooks/useMaskEditor';
import { useImagePipeline } from '../hooks/useImagePipeline';
import { useZoomPan } from '../hooks/useZoomPan';
import { useCoachMarks, suppressAllWalkthroughs } from '../hooks/useCoachMarks';
import { testConnection } from '../utils/comfyuiApi';
import { applyMaskedBlur, stackBlur, BLUR_MODE_LABELS } from '../utils/blurEngine';
import { track } from '../utils/analytics';
import ScreenShell from './ScreenShell';
import ConfirmModal from './ConfirmModal';
import CoachMark from './CoachMark';
import InsetZoom from './InsetZoom';
import { ProgressOverlay, ErrorOverlay } from './ApplyOverlay';
import { showRewardedAd } from '../utils/rewardedAd';
import { showClickadillaInterstitial, preloadAd } from '../utils/clickadillaAd';
import { loadAdsterraPopunder } from '../utils/adsterraAd';


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
    preloadAd();
    loadAdsterraPopunder();
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
  const blurTabRef = useRef(null);
  const tattooTabRef = useRef(null);
  const toolbarBodyRef = useRef(null);
  const applyBtnRef = useRef(null);

  const isMobile = /Mobi|Android/i.test(navigator.userAgent);

  const COACH_STEPS = [
    { targetRef: tattooTabRef, position: 'top', title: 'Two editing modes', body: 'Use Tattoo Removal to paint over tattoos, or Blur to hide faces. Switch between them using these tabs.' },
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
  const [category, setCategory] = useState(editorReturnMode === 'faceblur' ? 'blur' : (editorReturnMode || 'tattoo'));
  const [blurSubMode, setBlurSubMode] = useState('autoface');
  const [shapeType, setShapeType] = useState('oval');
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
    if (!blurDropdownOpen && !blurPickerOpen) return;
    const onClick = (e) => {
      if (blurDropdownOpen && blurDropdownRef.current && !blurDropdownRef.current.contains(e.target)) {
        setBlurDropdownOpen(false);
      }
      if (blurPickerOpen && blurTabRef.current && !blurTabRef.current.contains(e.target)) {
        setBlurPickerOpen(false);
      }
    };
    document.addEventListener('pointerdown', onClick);
    return () => document.removeEventListener('pointerdown', onClick);
  }, [blurDropdownOpen, blurPickerOpen]);

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
        ctx.fillStyle = 'white';
        if (det.shape === 'rectangle') {
          const w = (det.bottomRight[0] - det.topLeft[0]) * 1.1;
          const h = (det.bottomRight[1] - det.topLeft[1]) * 1.1;
          const cx = (det.topLeft[0] + det.bottomRight[0]) / 2;
          const cy = (det.topLeft[1] + det.bottomRight[1]) / 2;
          ctx.fillRect(cx - w/2, cy - h/2, w, h);
        } else {
          const cx = (det.topLeft[0] + det.bottomRight[0]) / 2;
          const cy = (det.topLeft[1] + det.bottomRight[1]) / 2;
          const rx = (det.bottomRight[0] - det.topLeft[0]) / 2 * 1.1;
          const ry = (det.bottomRight[1] - det.topLeft[1]) / 2 * 1.1;
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
          ctx.fill();
        }
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
    const { mode, strength } = blurSettingsRef.current;
    const mask = buildPreviewMask(dets, mode);
    if (!mask) return;

    const mCtx = mask.getContext('2d');
    const mData = mCtx.getImageData(0, 0, mask.width, mask.height);
    let hasMask = false;
    for (let i = 0; i < mData.data.length; i += 4) {
      if (mData.data[i + 3] > 0) { hasMask = true; break; }
    }

    if (!hasMask && !(mode === 'blackbar' && dets.length > 0)) {
      blurPreviewRef.current = null;
    } else {
      const bs = blurSettingsRef.current;
      const barSettings = mode === 'blackbar' ? { width: bs.barWidth ?? 20, length: bs.barLength ?? 110, angle: bs.barAngle ?? 0 } : null;
      blurPreviewRef.current = applyMaskedBlur(src, mask, mode, strength, dets, barSettings);
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

    display.width = imgW;
    display.height = imgH;
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
      tinted.width = imgW;
      tinted.height = imgH;
      tintedMaskRef.current = tinted;
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

  // --- Face region management ---
  const handleAddRegion = useCallback(() => {
    const hw = imgW * 0.075;
    const hh = shapeType === 'oval' ? hw * 1.3 : hw;
    const cx = imgW / 2;
    const cy = imgH / 2;
    const newDet = {
      topLeft: [cx - hw, cy - hh],
      bottomRight: [cx + hw, cy + hh],
      origHw: hw,
      origHh: hh,
      probability: 1,
      contour: [],
      keypoints: null,
      segData: null,
      manual: true,
      shape: shapeType,
    };
    setEditDets(prev => [...prev, newDet]);
    track('blur_region_added', { shape: shapeType });
  }, [imgW, imgH, shapeType, setEditDets]);

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
    const hasTattoo = (() => {
      const m = tattooMaskCanvasRef.current;
      if (!m) return false;
      const d = m.getContext('2d').getImageData(0, 0, m.width, m.height).data;
      for (let i = 3; i < d.length; i += 4) { if (d[i] > 128) return true; }
      return false;
    })();
    // Ad gates — only for tattoo removal, skip silently on error
    if (hasTattoo) {
      try { await showRewardedAd(); } catch { /* let user through */ }
      try { showClickadillaInterstitial(); } catch { /* non-blocking */ }
    }
    track('apply_clicked', { has_tattoo_mask: hasTattoo, face_regions: editDetsRef.current.length });
    setApplying(true);
    setApplyStatus('Preparing...');
    setApplyProgress(0);
    setApplyError(null);
    setElapsed(0);
    const t0 = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    abortRef.current = new AbortController();
    try {
      await recompositeWithCustomMask(tattooMaskCanvasRef.current, {
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
  }, [recompositeWithCustomMask, tattooMaskCanvasRef, setScreen, tattooMaskDirtyRef]);

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
    <ProgressOverlay progress={applyProgress} elapsed={elapsed} onCancel={handleCancelApply} />
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
      try { showClickadillaInterstitial(); } catch { /* non-blocking */ }
      // Server down but user has a tattoo mask — confirm before discarding it
      setShowOfflineConfirm(true);
      return;
    }
    handleApply();
  }, [comfyConnected, handleApply, handleSkip, tattooMaskCanvasRef, tattooMaskDirtyRef, inpaintedCanvasRef]);

  // Blur dropdown helper (shared between shape and freehand)
  const blurDropdownJSX = (
    <div className="blur-dropdown" ref={blurDropdownRef}>
      <button
        ref={blurTriggerRef}
        className="blur-dropdown-trigger"
        onClick={() => {
          setBlurDropdownOpen(v => {
            if (!v && blurTriggerRef.current) {
              const rect = blurTriggerRef.current.getBoundingClientRect();
              const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
              const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
              const nextLeft = Math.max(12, Math.min(rect.left, viewportWidth - rect.width - 12));
              setBlurDropdownPos({
                bottom: viewportHeight - rect.top + 6,
                left: nextLeft,
                minWidth: rect.width,
              });
            }
            return !v;
          });
        }}
        aria-expanded={blurDropdownOpen}
        aria-haspopup="listbox"
      >
        <span>{BLUR_MODE_LABELS[blurSettings.mode]}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points={blurDropdownOpen ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
        </svg>
      </button>
      {blurDropdownOpen && blurDropdownPos && (
        <div className="blur-dropdown-menu" role="listbox"
          style={{ bottom: blurDropdownPos.bottom, left: blurDropdownPos.left, minWidth: blurDropdownPos.minWidth }}>
          {[
            { value: 'gaussian', label: 'Gaussian' },
            { value: 'pixelate', label: 'Pixelate' },
            { value: 'blackbar', label: 'Black Bar' },
          ].map(opt => (
            <button
              key={opt.value}
              className={`blur-dropdown-item${blurSettings.mode === opt.value ? ' active' : ''}`}
              role="option"
              aria-selected={blurSettings.mode === opt.value}
              onClick={() => {
                setBlurSettings(prev => ({ ...prev, mode: opt.value }));
                track('blur_mode_changed', { mode: opt.value });
                setBlurDropdownOpen(false);
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const blurAdjustmentsRow = blurSettings.mode === 'blackbar' ? (
    <>
      <div className="toolbar-row">
        <div className="toolbar-group toolbar-group-dropdown">
          {blurDropdownJSX}
        </div>
        <div className="toolbar-group toolbar-group-slider">
          <label className="toolbar-slider">
            <span>Width</span>
            <input
              type="range"
              min="5"
              max="80"
              value={blurSettings.barWidth}
              onChange={(e) => { setBlurSettings(prev => ({ ...prev, barWidth: parseInt(e.target.value, 10) }));}}
            />
          </label>
        </div>
        <div className="toolbar-group toolbar-group-slider">
          <label className="toolbar-slider">
            <span>Length</span>
            <input
              type="range"
              min="50"
              max="200"
              value={blurSettings.barLength}
              onChange={(e) => { setBlurSettings(prev => ({ ...prev, barLength: parseInt(e.target.value, 10) }));}}
            />
          </label>
        </div>
      </div>
      <div className="toolbar-row">
        <div className="toolbar-group toolbar-group-slider toolbar-group-fill">
          <label className="toolbar-slider">
            <span>Angle</span>
            <input
              type="range"
              min="-45"
              max="45"
              value={blurSettings.barAngle}
              onChange={(e) => { setBlurSettings(prev => ({ ...prev, barAngle: parseInt(e.target.value, 10) }));}}
            />
          </label>
        </div>
      </div>
    </>
  ) : (
    <div className="toolbar-row">
      <div className="toolbar-group toolbar-group-dropdown">
        {blurDropdownJSX}
      </div>
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
  );

  const selectedBlurRegionRow = selectedOvalIdx !== null && editDets[selectedOvalIdx] ? (
    <div className="toolbar-row oval-resize-row">
      <div className="toolbar-group toolbar-group-inline">
        <span className="toolbar-label">
          {blurSubMode === 'autoface' ? 'Face' : 'Region'} {selectedOvalIdx + 1}
        </span>
      </div>
      <div className="toolbar-group toolbar-group-slider">
        <label className="toolbar-slider">
          <span>{blurSubMode === 'autoface' ? 'Size' : 'Resize'}</span>
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
          title={blurSubMode === 'autoface' ? 'Remove selected face' : 'Remove selected region'}
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
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <path d="M3.5 20.5c-1 1-2.5.5-2.5-.8 0-1.5 1.2-3.2 3-4.7l2 2c-1.5 1.8-2 3-2.5 3.5z" />
                    <path d="M6.5 15.5L18.8 3.2c.8-.8 2-.8 2.8 0l-.3.3c.8.8.8 2 0 2.8L8.5 18l-2-2.5z" />
                  </svg>
                  Brush
                </button>
                <button
                  className={`tool-btn ${activeTool === 'eraser' ? 'active' : ''}`}
                  onClick={() => setActiveTool('eraser')}
                  title="Erase mask areas"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M20 20H7L3 16l9-9 8 8-4 4" />
                    <path d="M6 11l4-4" />
                  </svg>
                  Eraser
                </button>
              </div>

              <div className="toolbar-group toolbar-group-buttons">
                <button className="tool-btn" onClick={() => { undo(); tattooMaskDirtyRef.current = true; forceRender(); }} disabled={!canUndo} title="Undo" aria-label="Undo">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="1 4 1 10 7 10" />
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                  </svg>
                  {undoCount > 0 && <span className="tool-badge">{undoCount}</span>}
                </button>
                <button className="tool-btn" onClick={() => { redo(); tattooMaskDirtyRef.current = true; forceRender(); }} disabled={!canRedo} title="Redo" aria-label="Redo">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="23 4 23 10 17 10" />
                    <path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" />
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
            {blurAdjustmentsRow}
            {selectedBlurRegionRow}
            <div className="toolbar-row">
              <div className="toolbar-group toolbar-group-buttons">
                <div className="shape-toggle">
                  <button className={`shape-toggle-btn${shapeType === 'oval' ? ' active' : ''}`}
                    onClick={() => setShapeType('oval')}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="12" rx="10" ry="7"/></svg>
                    Oval
                  </button>
                  <button className={`shape-toggle-btn${shapeType === 'rectangle' ? ' active' : ''}`}
                    onClick={() => setShapeType('rectangle')}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="2"/></svg>
                    Rectangle
                  </button>
                </div>
              </div>
              <div className="toolbar-group toolbar-group-inline">
                <button className="tool-btn" onClick={handleAddRegion} title="Add a blur region">
                  + Add
                </button>
              </div>
            </div>
          </div>
        )}

        {category === 'blur' && blurSubMode === 'autoface' && (
          <div className="toolbar-panel mask-editor-toolbar-panel">
            {blurAdjustmentsRow}
            {selectedBlurRegionRow}
            <div className="toolbar-row">
              <div className="toolbar-group toolbar-group-buttons">
                <button className="tool-btn" onClick={handleAutoDetect} title="Auto-detect faces in the image">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="10" r="6" />
                    <path d="M8 10h.01M16 10h.01" />
                    <path d="M9 13c.5.8 1.5 1 3 1s2.5-.2 3-1" />
                    <path d="M2 21v-1a7 7 0 0 1 7-7h6a7 7 0 0 1 7 7v1" />
                  </svg>
                  Detect Faces
                </button>
                <button className="tool-btn" onClick={handleClearFaces} title="Clear all face blur regions">
                  Clear All
                </button>
              </div>
            </div>
          </div>
        )}

        {category === 'blur' && blurSubMode === 'freehand' && (
          <div className="toolbar-panel mask-editor-toolbar-panel">
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
            {blurSettings.mode === 'blackbar' ? (
              <>
                <div className="toolbar-row">
                  <div className="toolbar-group toolbar-group-slider">
                    <label className="toolbar-slider">
                      <span>Width</span>
                      <input
                        type="range"
                        min="5"
                        max="80"
                        value={blurSettings.barWidth}
                        onChange={(e) => { setBlurSettings(prev => ({ ...prev, barWidth: parseInt(e.target.value, 10) }));}}
                      />
                    </label>
                  </div>
                  <div className="toolbar-group toolbar-group-slider">
                    <label className="toolbar-slider">
                      <span>Length</span>
                      <input
                        type="range"
                        min="50"
                        max="200"
                        value={blurSettings.barLength}
                        onChange={(e) => { setBlurSettings(prev => ({ ...prev, barLength: parseInt(e.target.value, 10) }));}}
                      />
                    </label>
                  </div>
                </div>
                <div className="toolbar-row">
                  <div className="toolbar-group toolbar-group-slider toolbar-group-fill">
                    <label className="toolbar-slider">
                      <span>Angle</span>
                      <input
                        type="range"
                        min="-45"
                        max="45"
                        value={blurSettings.barAngle}
                        onChange={(e) => { setBlurSettings(prev => ({ ...prev, barAngle: parseInt(e.target.value, 10) }));}}
                      />
                    </label>
                  </div>
                </div>
              </>
            ) : (
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
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <path d="M3.5 20.5c-1 1-2.5.5-2.5-.8 0-1.5 1.2-3.2 3-4.7l2 2c-1.5 1.8-2 3-2.5 3.5z" />
                    <path d="M6.5 15.5L18.8 3.2c.8-.8 2-.8 2.8 0l-.3.3c.8.8.8 2 0 2.8L8.5 18l-2-2.5z" />
                  </svg>
                  Paint
                </button>
                <button
                  className={`tool-btn ${faceBlurTool === 'eraser' ? 'active' : ''}`}
                  onClick={() => setFaceBlurTool('eraser')}
                  title="Erase painted blur regions"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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

      {/* Level 1: Category tabs (bottom of toolbar) */}
      <div className="toolbar-tabs">
        <button ref={tattooTabRef} className={`toolbar-tab${category === 'tattoo' ? ' active' : ''}`}
          onClick={() => { setCategory('tattoo'); setBlurPickerOpen(false); }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3.5 20.5c-1 1-2.5.5-2.5-.8 0-1.5 1.2-3.2 3-4.7l2 2c-1.5 1.8-2 3-2.5 3.5z" />
            <path d="M6.5 15.5L18.8 3.2c.8-.8 2-.8 2.8 0l-.3.3c.8.8.8 2 0 2.8L8.5 18l-2-2.5z" />
          </svg>
          Tattoo Removal
        </button>
        <div className="toolbar-tab-wrapper" ref={blurTabRef}>
          <button className={`toolbar-tab${category === 'blur' ? ' active' : ''}`}
            onClick={() => {
              if (category !== 'blur') {
                setCategory('blur');
              } else {
                setBlurPickerOpen(v => !v);
              }
            }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
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
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="10" r="6" />
                    <path d="M9 9h.01M15 9h.01" />
                  </svg>
                )},
                { value: 'shape', label: 'Shape Blur', icon: (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="12" rx="10" ry="7"/></svg>
                )},
                { value: 'freehand', label: 'Freehand Blur', icon: (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <path d="M3.5 20.5c-1 1-2.5.5-2.5-.8 0-1.5 1.2-3.2 3-4.7l2 2c-1.5 1.8-2 3-2.5 3.5z" />
                    <path d="M6.5 15.5L18.8 3.2c.8-.8 2-.8 2.8 0l-.3.3c.8.8.8 2 0 2.8L8.5 18l-2-2.5z" />
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
              style={{ cursor: 'none', touchAction: 'none' }}
              onPointerDown={category === 'tattoo' ? onTattooDown : (blurSubMode === 'freehand' ? onFaceBlurDown : onShapeCanvasDown)}
            />
            {editDets.map((det, i) => (
              <div
                key={`face-${i}`}
                className={`face-overlay${selectedOvalIdx === i ? ' selected' : ''}${det.shape === 'rectangle' ? ' rectangle' : ''}`}
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
    </ScreenShell>
  );
}
