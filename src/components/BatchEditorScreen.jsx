import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useBatch } from '../context/BatchContext';
import { useZoomPan } from '../hooks/useZoomPan';
import { applyMaskedBlur, stackBlur, BLUR_MODE_LABELS, FACE_BOX_EXPAND } from '../utils/blurEngine';
import { buildFaceMask, createThumbnail, canvasToBlobUrl } from '../utils/batchProcessor';
import ScreenShell from './ScreenShell';
import ConfirmModal from './ConfirmModal';
import { track } from '../utils/analytics';


export default function BatchEditorScreen({ onBack }) {
  const {
    images, activeImageId, updateImage,
    globalBlurSettings, globalFeather,
    batchDirtyRef,
  } = useBatch();

  const imageEntry = useMemo(
    () => images.find(img => img.id === activeImageId),
    [images, activeImageId]
  );

  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const blurPreviewRef = useRef(null);
  const faceBlurCanvasRef = useRef(null);
  const tattooMaskCanvasRef = useRef(null);
  // Reusable offscreen canvas for tinting the tattoo mask into a red overlay.
  // Allocated once and resized on demand so rapid strokes don't thrash the
  // allocator. Same pattern as MaskEditorScreen.renderDisplay.
  const tintedMaskRef = useRef(null);
  const rafRef = useRef(null);
  const drawRafRef = useRef(null);
  const globalListenersRef = useRef([]);

  // Top-level editing mode: tattoo (ComfyUI mask) vs blur (face regions).
  // Mirrors MaskEditorScreen's `category` state. Default 'blur' preserves the
  // pre-tattoo batch UX — users entering from a face-batch flow see the same
  // toolbar they always saw.
  const [topMode, setTopMode] = useState('blur');
  // Blur sub-mode: autoface | shape | freehand
  const [blurSubMode, setBlurSubMode] = useState('autoface');
  const [blurPickerOpen, setBlurPickerOpen] = useState(false);
  const blurTabRef = useRef(null);
  const tattooTabRef = useRef(null);

  const TATTOO_MASK_COLOR = [255, 80, 80];

  // Local editing state
  const [editDets, setEditDets] = useState([]);
  const [localMode, setLocalMode] = useState('gaussian');
  const [localStrength, setLocalStrength] = useState(20);
  const [localFeather, setLocalFeather] = useState(0);
  const [localBarWidth, setLocalBarWidth] = useState(20);
  const [localBarLength, setLocalBarLength] = useState(110);
  const [localBarAngle, setLocalBarAngle] = useState(0);
  const [shapeType, setShapeType] = useState('oval');
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [renderKey, setRenderKey] = useState(0);

  // Dirty flag — set when user changes any editing state. Lives in BatchContext
  // so ScreenRouter's popstate handler can block browser-back with a confirm
  // instead of silently discarding edits. Skips the first render so loading
  // initial values doesn't trigger it, and resets on unmount so the next visit
  // to the editor starts clean.
  const mountedRef = useRef(false);
  const [showConfirmBack, setShowConfirmBack] = useState(false);
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    batchDirtyRef.current = true;
  }, [batchDirtyRef, editDets, localMode, localStrength, localFeather, localBarWidth, localBarLength, localBarAngle]);
  useEffect(() => () => { batchDirtyRef.current = false; }, [batchDirtyRef]);
  // Release the final blur-preview canvas on unmount so navigating away
  // doesn't leave a full-res bitmap pinned until the next GC pass.
  useEffect(() => () => {
    const c = blurPreviewRef.current;
    if (c) { c.width = 0; c.height = 0; }
    blurPreviewRef.current = null;
  }, []);

  // Freehand painting state
  const [faceBlurTool, setFaceBlurTool] = useState('brush');
  const [faceBlurBrushSize, setFaceBlurBrushSize] = useState(40);
  const faceBlurToolRef = useRef('brush');
  const faceBlurBrushSizeRef = useRef(40);
  const faceBlurPaintingRef = useRef(false);
  const faceBlurLastPosRef = useRef(null);
  const [cursorPos, setCursorPos] = useState(null);
  const touchDelayRef = useRef(null);

  // Blur dropdown
  const [blurDropdownOpen, setBlurDropdownOpen] = useState(false);
  const [blurDropdownPos, setBlurDropdownPos] = useState(null);
  const blurDropdownRef = useRef(null);
  const blurTriggerRef = useRef(null);

  // Keep refs in sync for rAF callbacks
  const editDetsRef = useRef(editDets);
  const localModeRef = useRef(localMode);
  const localStrengthRef = useRef(localStrength);
  const localFeatherRef = useRef(localFeather);
  const localBarWidthRef = useRef(localBarWidth);
  const localBarLengthRef = useRef(localBarLength);
  const localBarAngleRef = useRef(localBarAngle);
  useEffect(() => { editDetsRef.current = editDets; }, [editDets]);
  useEffect(() => { localModeRef.current = localMode; }, [localMode]);
  useEffect(() => { localStrengthRef.current = localStrength; }, [localStrength]);
  useEffect(() => { localFeatherRef.current = localFeather; }, [localFeather]);
  useEffect(() => { localBarWidthRef.current = localBarWidth; }, [localBarWidth]);
  useEffect(() => { localBarLengthRef.current = localBarLength; }, [localBarLength]);
  useEffect(() => { localBarAngleRef.current = localBarAngle; }, [localBarAngle]);
  useEffect(() => { faceBlurToolRef.current = faceBlurTool; }, [faceBlurTool]);
  useEffect(() => { faceBlurBrushSizeRef.current = faceBlurBrushSize; }, [faceBlurBrushSize]);
  useEffect(() => () => clearTimeout(touchDelayRef.current), []);

  const forceRender = useCallback(() => setRenderKey(k => k + 1), []);

  // Close popovers on outside click
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

  // Initialize local state from batch entry
  useEffect(() => {
    if (!imageEntry) return;
    const dets = imageEntry.editDetections || imageEntry.detections || [];
    setEditDets(dets.map(d => ({
      ...d,
      enabled: d.enabled !== false,
      origHw: d.origHw || (d.bottomRight[0] - d.topLeft[0]) / 2,
      origHh: d.origHh || (d.bottomRight[1] - d.topLeft[1]) / 2,
    })));
    const settings = imageEntry.blurSettings || globalBlurSettings;
    setLocalMode(settings.mode);
    setLocalStrength(settings.strength);
    setLocalFeather(imageEntry.localFeather ?? globalFeather);
    setLocalBarWidth(settings.barWidth ?? globalBlurSettings.barWidth ?? 20);
    setLocalBarLength(settings.barLength ?? globalBlurSettings.barLength ?? 110);
    setLocalBarAngle(settings.barAngle ?? globalBlurSettings.barAngle ?? 0);
    setSelectedIdx(null);

    // Initialize faceBlurCanvas
    const src = imageEntry.strippedCanvas;
    if (src && src.width && src.height) {
      const c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      // Restore previous freehand strokes if saved
      if (imageEntry.faceBlurCanvas) {
        c.getContext('2d').drawImage(imageEntry.faceBlurCanvas, 0, 0);
      }
      faceBlurCanvasRef.current = c;

      // Initialize tattoo mask canvas — parallel to faceBlurCanvas, restored
      // from the saved entry so users can re-enter the editor and keep painting.
      const tm = document.createElement('canvas');
      tm.width = src.width;
      tm.height = src.height;
      if (imageEntry.tattooMaskCanvas) {
        tm.getContext('2d').drawImage(imageEntry.tattooMaskCanvas, 0, 0);
      }
      tattooMaskCanvasRef.current = tm;
    }
  }, [imageEntry?.id]);

  const src = imageEntry?.strippedCanvas;
  const imgW = src?.width || 1;
  const imgH = src?.height || 1;

  const {
    getTransformStyle, screenToImage,
    handleTouchStart, handleTouchMove, handleTouchEnd,
    isPanning,
  } = useZoomPan(imgW, imgH, containerRef);

  // Deselect if index out of range
  useEffect(() => {
    if (selectedIdx !== null && selectedIdx >= editDets.length) setSelectedIdx(null);
  }, [editDets.length, selectedIdx]);

  // Build blur preview (combines detection shapes + freehand canvas)
  const buildPreviewMask = useCallback((dets, mode) => {
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
          const w = (det.bottomRight[0] - det.topLeft[0]) * FACE_BOX_EXPAND;
          const h = (det.bottomRight[1] - det.topLeft[1]) * FACE_BOX_EXPAND;
          const cx = (det.topLeft[0] + det.bottomRight[0]) / 2;
          const cy = (det.topLeft[1] + det.bottomRight[1]) / 2;
          ctx.fillRect(cx - w/2, cy - h/2, w, h);
        } else {
          const cx = (det.topLeft[0] + det.bottomRight[0]) / 2;
          const cy = (det.topLeft[1] + det.bottomRight[1]) / 2;
          const rx = (det.bottomRight[0] - det.topLeft[0]) / 2 * FACE_BOX_EXPAND;
          const ry = (det.bottomRight[1] - det.topLeft[1]) / 2 * FACE_BOX_EXPAND;
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Merge freehand brush strokes
    if (faceBlurCanvasRef.current) {
      ctx.drawImage(faceBlurCanvasRef.current, 0, 0);
    }

    // Apply feather
    const fr = localFeatherRef.current;
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
  }, [src]);

  const updateBlurPreview = useCallback(() => {
    if (!src) return;
    const dets = editDetsRef.current.filter(d => d.enabled);
    const mode = localModeRef.current;
    const strength = localStrengthRef.current;
    const mask = buildPreviewMask(dets, mode);
    if (!mask) return;

    const mCtx = mask.getContext('2d');
    const mData = mCtx.getImageData(0, 0, mask.width, mask.height);
    let hasMask = false;
    for (let i = 0; i < mData.data.length; i += 4) {
      if (mData.data[i + 3] > 0) { hasMask = true; break; }
    }

    // Free the previous preview's bitmap before replacing it. Without this
    // zero-out the old canvas keeps its ImageData pinned until GC, and
    // slider scrubbing at 60 fps can stack dozens of full-res canvases in
    // memory (~16 MB each at 4 MP).
    const prev = blurPreviewRef.current;
    if (prev) { prev.width = 0; prev.height = 0; }

    if (!hasMask && !(mode === 'blackbar' && dets.length > 0)) {
      blurPreviewRef.current = null;
    } else {
      const barSettings = mode === 'blackbar' ? { width: localBarWidthRef.current, length: localBarLengthRef.current, angle: localBarAngleRef.current } : null;
      blurPreviewRef.current = applyMaskedBlur(src, mask, mode, strength, dets, barSettings);
    }
  }, [src, buildPreviewMask]);

  const scheduleBlurPreview = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      updateBlurPreview();
      forceRender();
    });
  }, [updateBlurPreview, forceRender]);

  useEffect(() => { scheduleBlurPreview(); }, [editDets, localMode, localStrength, localFeather, localBarWidth, localBarLength, localBarAngle]);

  // Render display canvas
  const renderDisplay = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !src) return;
    canvas.width = imgW;
    canvas.height = imgH;
    const ctx = canvas.getContext('2d');

    // Base layer: on the Tattoo tab we show the raw source so the user sees
    // exactly what the mask covers. On the Blur tab we show the blur preview
    // (or the raw source when there's nothing to blur yet).
    if (topMode === 'blur' && blurPreviewRef.current) {
      ctx.drawImage(blurPreviewRef.current, 0, 0);
    } else {
      ctx.drawImage(src, 0, 0);
    }

    // Tattoo mask overlay — always rendered if the mask has any painted pixels,
    // regardless of active tab, so the user can see it persist when they switch
    // over to Blur. Uses the offscreen tint trick (source-in + fillRect) for
    // GPU-accelerated recoloring instead of a per-pixel JS loop.
    const maskSrc = tattooMaskCanvasRef.current;
    if (maskSrc) {
      const tinted = tintedMaskRef.current || document.createElement('canvas');
      tinted.width = imgW;
      tinted.height = imgH;
      tintedMaskRef.current = tinted;
      const tCtx = tinted.getContext('2d');
      tCtx.clearRect(0, 0, imgW, imgH);
      tCtx.drawImage(maskSrc, 0, 0);
      tCtx.globalCompositeOperation = 'source-in';
      tCtx.fillStyle = `rgb(${TATTOO_MASK_COLOR[0]}, ${TATTOO_MASK_COLOR[1]}, ${TATTOO_MASK_COLOR[2]})`;
      tCtx.fillRect(0, 0, imgW, imgH);
      tCtx.globalCompositeOperation = 'source-over';
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.drawImage(tinted, 0, 0);
      ctx.restore();
    }
  }, [src, imgW, imgH, topMode]);

  useEffect(() => {
    if (drawRafRef.current != null) return;
    drawRafRef.current = requestAnimationFrame(() => {
      drawRafRef.current = null;
      renderDisplay();
    });
    return () => {
      if (drawRafRef.current != null) {
        cancelAnimationFrame(drawRafRef.current);
        drawRafRef.current = null;
      }
    };
  }, [renderDisplay, renderKey]);

  // Cleanup
  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    cancelAnimationFrame(drawRafRef.current);
    globalListenersRef.current.forEach(fn => fn());
  }, []);

  // Lock body scroll
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // --- Drag to move a face region ---
  const handleFaceDragDown = useCallback((e, index) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedIdx(index);

    const startPt = screenToImage(e.clientX, e.clientY, canvasRef.current);
    const dets = editDetsRef.current;
    const origTL = [...dets[index].topLeft];
    const origBR = [...dets[index].bottomRight];

    const onMove = (ev) => {
      ev.preventDefault();
      const curPt = screenToImage(ev.clientX, ev.clientY, canvasRef.current);
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
    const onUp = () => cleanup();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    globalListenersRef.current.push(cleanup);
  }, [screenToImage, forceRender]);

  // --- Resize via slider ---
  const handleOvalResize = useCallback((newPercent) => {
    if (selectedIdx === null) return;
    const det = editDetsRef.current[selectedIdx];
    if (!det || !det.origHw) return;
    const scale = newPercent / 100;
    const cx = (det.topLeft[0] + det.bottomRight[0]) / 2;
    const cy = (det.topLeft[1] + det.bottomRight[1]) / 2;
    const hw = det.origHw * scale;
    const hh = det.origHh * scale;
    const newDets = [...editDetsRef.current];
    newDets[selectedIdx] = {
      ...newDets[selectedIdx],
      topLeft: [cx - hw, cy - hh],
      bottomRight: [cx + hw, cy + hh],
    };
    setEditDets(newDets);
    editDetsRef.current = newDets;
    forceRender();
  }, [selectedIdx, forceRender]);

  // Remove a detection
  const handleRemoveFace = useCallback((idx) => {
    setEditDets(prev => prev.filter((_, i) => i !== idx));
    setSelectedIdx(null);
  }, []);

  // Add region (shape mode)
  const handleAddRegion = useCallback(() => {
    const hw = imgW * 0.075;
    const hh = shapeType === 'oval' ? hw * 1.3 : hw;
    const cx = imgW / 2;
    const cy = imgH / 2;
    setEditDets(prev => [...prev, {
      topLeft: [cx - hw, cy - hh],
      bottomRight: [cx + hw, cy + hh],
      origHw: hw,
      origHh: hh,
      enabled: true,
      type: 'manual',
      shape: shapeType,
    }]);
    setSelectedIdx(editDetsRef.current.length);
  }, [imgW, imgH, shapeType]);

  // Clear all faces
  const handleClearFaces = useCallback(() => {
    setEditDets([]);
    setSelectedIdx(null);
    if (faceBlurCanvasRef.current) {
      faceBlurCanvasRef.current.getContext('2d').clearRect(0, 0, imgW, imgH);
    }
    scheduleBlurPreview();
  }, [imgW, imgH, scheduleBlurPreview]);

  // Clear freehand brush
  const handleClearBlurBrush = useCallback(() => {
    if (!faceBlurCanvasRef.current) return;
    faceBlurCanvasRef.current.getContext('2d').clearRect(0, 0, imgW, imgH);
    scheduleBlurPreview();
    forceRender();
  }, [imgW, imgH, scheduleBlurPreview, forceRender]);

  // --- Freehand painting (shared by Blur-freehand and Tattoo-removal modes) ---
  // Paints into `target` (either faceBlurCanvasRef or tattooMaskCanvasRef).
  // Brush/eraser tool + brush size are shared — the UI only shows one set of
  // controls at a time, gated by the active tab.
  const paintStroke = useCallback((target, from, to) => {
    if (!target) return;
    const ctx = target.getContext('2d');
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
  }, []);

  // Starts a paint loop on the given target canvas. `afterStroke` fires after
  // each segment — the blur-target uses it to refresh the blur preview; the
  // tattoo-target uses it to trigger a redisplay (no blur involved).
  const startStrokeOn = useCallback((e, target, afterStroke) => {
    faceBlurPaintingRef.current = true;
    batchDirtyRef.current = true;
    setCursorPos({ x: e.clientX, y: e.clientY });
    const pt = screenToImage(e.clientX, e.clientY, canvasRef.current);
    faceBlurLastPosRef.current = pt;
    paintStroke(target, null, pt);
    afterStroke();

    const pointerType = e.pointerType || 'mouse';
    const onMove = (ev) => {
      if (!faceBlurPaintingRef.current || isPanning.current) return;
      ev.preventDefault();
      const pt2 = screenToImage(ev.clientX, ev.clientY, canvasRef.current);
      paintStroke(target, faceBlurLastPosRef.current, pt2);
      faceBlurLastPosRef.current = pt2;
      setCursorPos({ x: ev.clientX, y: ev.clientY });
      afterStroke();
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
      afterStroke();
      cleanup();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    globalListenersRef.current.push(cleanup);
  }, [screenToImage, isPanning, paintStroke]);

  const onFaceBlurDown = useCallback((e) => {
    if (isPanning.current) return;
    e.preventDefault();
    setSelectedIdx(null);
    const start = (evt) => startStrokeOn(evt, faceBlurCanvasRef.current, scheduleBlurPreview);
    if (e.pointerType === 'touch') {
      const savedEvent = { clientX: e.clientX, clientY: e.clientY, pressure: e.pressure, pointerType: e.pointerType };
      clearTimeout(touchDelayRef.current);
      touchDelayRef.current = setTimeout(() => {
        if (!isPanning.current) start(savedEvent);
      }, 50);
      return;
    }
    start(e);
  }, [isPanning, startStrokeOn, scheduleBlurPreview]);

  const onTattooDown = useCallback((e) => {
    if (isPanning.current) return;
    e.preventDefault();
    setSelectedIdx(null);
    const start = (evt) => startStrokeOn(evt, tattooMaskCanvasRef.current, forceRender);
    if (e.pointerType === 'touch') {
      const savedEvent = { clientX: e.clientX, clientY: e.clientY, pressure: e.pressure, pointerType: e.pointerType };
      clearTimeout(touchDelayRef.current);
      touchDelayRef.current = setTimeout(() => {
        if (!isPanning.current) start(savedEvent);
      }, 50);
      return;
    }
    start(e);
  }, [isPanning, startStrokeOn, forceRender]);

  const handleClearTattooMask = useCallback(() => {
    const c = tattooMaskCanvasRef.current;
    if (!c) return;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    batchDirtyRef.current = true;
    forceRender();
  }, [batchDirtyRef, forceRender]);

  // Shape mode: deselect on background
  const onShapeCanvasDown = useCallback((e) => {
    if (isPanning.current) return;
    e.preventDefault();
    setSelectedIdx(null);
  }, [isPanning]);

  // Touch start that cancels strokes on pinch
  const onContainerTouchStart = useCallback((e) => {
    if (e.touches.length >= 2) {
      clearTimeout(touchDelayRef.current);
      touchDelayRef.current = null;
      faceBlurPaintingRef.current = false;
    }
    handleTouchStart(e);
  }, [handleTouchStart]);

  // --- Save edits + generate preview thumbnail ---
  const handleDone = useCallback(async () => {
    if (!imageEntry || !src) { onBack(); return; }

    const enabledDets = editDets.filter(d => d.enabled);
    const mask = buildPreviewMask(enabledDets, localMode);

    let previewCanvas = null;
    if (mask) {
      const mData = mask.getContext('2d').getImageData(0, 0, mask.width, mask.height);
      let hasMask = false;
      for (let i = 0; i < mData.data.length; i += 4) {
        if (mData.data[i + 3] > 0) { hasMask = true; break; }
      }
      if (hasMask || (localMode === 'blackbar' && enabledDets.length > 0)) {
        const barSettings = localMode === 'blackbar' ? { width: localBarWidth, length: localBarLength, angle: localBarAngle } : null;
        previewCanvas = applyMaskedBlur(src, mask, localMode, localStrength, enabledDets, barSettings);
      }
    }

    const thumbSource = previewCanvas || src;
    const thumbnailCanvas = createThumbnail(thumbSource);
    if (imageEntry.thumbnailUrl) URL.revokeObjectURL(imageEntry.thumbnailUrl);
    const thumbnailUrl = await canvasToBlobUrl(thumbnailCanvas);

    updateImage(imageEntry.id, {
      editDetections: editDets,
      blurSettings: { mode: localMode, strength: localStrength, barWidth: localBarWidth, barLength: localBarLength, barAngle: localBarAngle },
      localFeather: localFeather,
      faceBlurCanvas: faceBlurCanvasRef.current,
      tattooMaskCanvas: tattooMaskCanvasRef.current,
      status: 'edited',
      thumbnailCanvas,
      thumbnailUrl,
    });
    onBack();
  }, [imageEntry, src, editDets, localMode, localStrength, localFeather, localBarWidth, localBarLength, localBarAngle, buildPreviewMask, updateImage, onBack]);

  if (!imageEntry || !src) {
    return (
      <ScreenShell backAction={onBack} backLabel="Back" stepLabel="Editing">
        <div className="batch-editor-empty" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: 'var(--text-dim)' }}>Image not found</div>
      </ScreenShell>
    );
  }

  const selectedOvalScale = selectedIdx !== null && editDets[selectedIdx]?.origHw
    ? Math.round(((editDets[selectedIdx].bottomRight[0] - editDets[selectedIdx].topLeft[0]) / 2) / editDets[selectedIdx].origHw * 100)
    : 100;

  // --- Blur dropdown (shared between shape and freehand) ---
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
              setBlurDropdownPos({ bottom: viewportHeight - rect.top + 6, left: nextLeft, minWidth: rect.width });
            }
            return !v;
          });
        }}
        aria-expanded={blurDropdownOpen}
        aria-haspopup="listbox"
      >
        <span>{BLUR_MODE_LABELS[localMode]}</span>
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
              className={`blur-dropdown-item${localMode === opt.value ? ' active' : ''}`}
              role="option"
              aria-selected={localMode === opt.value}
              onClick={() => { setLocalMode(opt.value); setBlurDropdownOpen(false); }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const blurAdjustmentsRow = localMode === 'blackbar' ? (
    <>
      <div className="toolbar-row">
        <div className="toolbar-group toolbar-group-dropdown">
          {blurDropdownJSX}
        </div>
        <div className="toolbar-group toolbar-group-slider">
          <label className="toolbar-slider">
            <span>Width</span>
            <input type="range" min="5" max="80" value={localBarWidth}
              onChange={(e) => { setLocalBarWidth(parseInt(e.target.value, 10));}} />
          </label>
        </div>
        <div className="toolbar-group toolbar-group-slider">
          <label className="toolbar-slider">
            <span>Length</span>
            <input type="range" min="50" max="200" value={localBarLength}
              onChange={(e) => { setLocalBarLength(parseInt(e.target.value, 10));}} />
          </label>
        </div>
      </div>
      <div className="toolbar-row">
        <div className="toolbar-group toolbar-group-slider toolbar-group-fill">
          <label className="toolbar-slider">
            <span>Angle</span>
            <input type="range" min="-45" max="45" value={localBarAngle}
              onChange={(e) => { setLocalBarAngle(parseInt(e.target.value, 10));}} />
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
          <input type="range" min="5" max="60" value={localStrength}
            onChange={(e) => { setLocalStrength(parseInt(e.target.value, 10));}} />
        </label>
      </div>
      <div className="toolbar-group toolbar-group-slider">
        <label className="toolbar-slider">
          <span>Feather</span>
          <input type="range" min="0" max="60" value={localFeather}
            onChange={(e) => { setLocalFeather(parseInt(e.target.value, 10));}} />
        </label>
      </div>
    </div>
  );

  const selectedBlurRegionRow = selectedIdx !== null && editDets[selectedIdx] ? (
    <div className="toolbar-row oval-resize-row">
      <div className="toolbar-group toolbar-group-inline">
        <span className="toolbar-label">
          {blurSubMode === 'autoface' ? 'Face' : 'Region'} {selectedIdx + 1}
        </span>
      </div>
      <div className="toolbar-group toolbar-group-slider">
        <label className="toolbar-slider">
          <span>{blurSubMode === 'autoface' ? 'Size' : 'Resize'}</span>
          <input type="range" min="30" max="300" value={selectedOvalScale}
            onChange={(e) => { handleOvalResize(parseInt(e.target.value, 10));}} />
        </label>
      </div>
      <div className="toolbar-group toolbar-group-inline">
        <button className="tool-btn" onClick={() => handleRemoveFace(selectedIdx)}
          title="Remove selected region">
          Remove
        </button>
      </div>
    </div>
  ) : null;

  // --- Toolbar content (mirrors main editor layout exactly) ---
  const toolbarContent = (
    <div className="bottom-toolbar-inner mask-editor-toolbar">
      <div className="mask-editor-toolbar-body">
        {topMode === 'tattoo' && (
          <div className="toolbar-panel mask-editor-toolbar-panel">
            <div className="toolbar-row brush-size-row">
              <div className="toolbar-group toolbar-group-slider toolbar-group-fill">
                <label className="toolbar-slider">
                  <span>Brush Size</span>
                  <input type="range" min={10} max={150} value={faceBlurBrushSize}
                    onChange={(e) => { setFaceBlurBrushSize(parseInt(e.target.value, 10));}} />
                </label>
              </div>
            </div>
            <div className="toolbar-row">
              <div className="toolbar-group toolbar-group-buttons">
                <button className={`tool-btn ${faceBlurTool === 'brush' ? 'active' : ''}`}
                  onClick={() => setFaceBlurTool('brush')} title="Paint over tattoos to remove">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <path d="M3.5 20.5c-1 1-2.5.5-2.5-.8 0-1.5 1.2-3.2 3-4.7l2 2c-1.5 1.8-2 3-2.5 3.5z" />
                    <path d="M6.5 15.5L18.8 3.2c.8-.8 2-.8 2.8 0l-.3.3c.8.8.8 2 0 2.8L8.5 18l-2-2.5z" />
                  </svg>
                  Paint
                </button>
                <button className={`tool-btn ${faceBlurTool === 'eraser' ? 'active' : ''}`}
                  onClick={() => setFaceBlurTool('eraser')} title="Erase painted tattoo mask">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M20 20H7L3 16l9-9 8 8-4 4" />
                    <path d="M6 11l4-4" />
                  </svg>
                  Erase
                </button>
              </div>
              <div className="toolbar-group toolbar-group-inline">
                <button className="tool-btn" onClick={handleClearTattooMask} title="Clear tattoo mask">
                  Clear
                </button>
              </div>
            </div>
          </div>
        )}

        {topMode === 'blur' && blurSubMode === 'shape' && (
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

        {topMode === 'blur' && blurSubMode === 'autoface' && (
          <div className="toolbar-panel mask-editor-toolbar-panel">
            {blurAdjustmentsRow}
            {selectedBlurRegionRow}
            <div className="toolbar-row">
              <div className="toolbar-group toolbar-group-buttons">
                <button className="tool-btn" onClick={handleClearFaces} title="Clear all face blur regions">
                  Clear All
                </button>
              </div>
            </div>
          </div>
        )}

        {topMode === 'blur' && blurSubMode === 'freehand' && (
          <div className="toolbar-panel mask-editor-toolbar-panel">
            <div className="toolbar-row brush-size-row">
              <div className="toolbar-group toolbar-group-dropdown">
                {blurDropdownJSX}
              </div>
              <div className="toolbar-group toolbar-group-slider">
                <label className="toolbar-slider">
                  <span>Brush Size</span>
                  <input type="range" min={10} max={150} value={faceBlurBrushSize}
                    onChange={(e) => { setFaceBlurBrushSize(parseInt(e.target.value, 10));}} />
                </label>
              </div>
            </div>
            {localMode === 'blackbar' ? (
              <>
                <div className="toolbar-row">
                  <div className="toolbar-group toolbar-group-slider">
                    <label className="toolbar-slider">
                      <span>Width</span>
                      <input type="range" min="5" max="80" value={localBarWidth}
                        onChange={(e) => { setLocalBarWidth(parseInt(e.target.value, 10));}} />
                    </label>
                  </div>
                  <div className="toolbar-group toolbar-group-slider">
                    <label className="toolbar-slider">
                      <span>Length</span>
                      <input type="range" min="50" max="200" value={localBarLength}
                        onChange={(e) => { setLocalBarLength(parseInt(e.target.value, 10));}} />
                    </label>
                  </div>
                </div>
                <div className="toolbar-row">
                  <div className="toolbar-group toolbar-group-slider toolbar-group-fill">
                    <label className="toolbar-slider">
                      <span>Angle</span>
                      <input type="range" min="-45" max="45" value={localBarAngle}
                        onChange={(e) => { setLocalBarAngle(parseInt(e.target.value, 10));}} />
                    </label>
                  </div>
                </div>
              </>
            ) : (
              <div className="toolbar-row">
                <div className="toolbar-group toolbar-group-slider">
                  <label className="toolbar-slider">
                    <span>Blur Strength</span>
                    <input type="range" min="5" max="60" value={localStrength}
                      onChange={(e) => { setLocalStrength(parseInt(e.target.value, 10));}} />
                  </label>
                </div>
                <div className="toolbar-group toolbar-group-slider">
                  <label className="toolbar-slider">
                    <span>Feather</span>
                    <input type="range" min="0" max="60" value={localFeather}
                      onChange={(e) => { setLocalFeather(parseInt(e.target.value, 10));}} />
                  </label>
                </div>
              </div>
            )}
            <div className="toolbar-row">
              <div className="toolbar-group toolbar-group-buttons">
                <button className={`tool-btn ${faceBlurTool === 'brush' ? 'active' : ''}`}
                  onClick={() => setFaceBlurTool('brush')} title="Paint blur regions freehand">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <path d="M3.5 20.5c-1 1-2.5.5-2.5-.8 0-1.5 1.2-3.2 3-4.7l2 2c-1.5 1.8-2 3-2.5 3.5z" />
                    <path d="M6.5 15.5L18.8 3.2c.8-.8 2-.8 2.8 0l-.3.3c.8.8.8 2 0 2.8L8.5 18l-2-2.5z" />
                  </svg>
                  Paint
                </button>
                <button className={`tool-btn ${faceBlurTool === 'eraser' ? 'active' : ''}`}
                  onClick={() => setFaceBlurTool('eraser')} title="Erase painted blur regions">
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

      {/* Level 1: Top-mode tabs (Tattoo Removal / Blur) — mirrors MaskEditorScreen */}
      <div className="toolbar-tabs">
        <button ref={tattooTabRef}
          className={`toolbar-tab${topMode === 'tattoo' ? ' active' : ''}`}
          onClick={() => { setTopMode('tattoo'); setBlurPickerOpen(false); setSelectedIdx(null); }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3.5 20.5c-1 1-2.5.5-2.5-.8 0-1.5 1.2-3.2 3-4.7l2 2c-1.5 1.8-2 3-2.5 3.5z" />
            <path d="M6.5 15.5L18.8 3.2c.8-.8 2-.8 2.8 0l-.3.3c.8.8.8 2 0 2.8L8.5 18l-2-2.5z" />
          </svg>
          Tattoo Removal
        </button>
        <div className="toolbar-tab-wrapper" ref={blurTabRef}>
          <button className={`toolbar-tab${topMode === 'blur' ? ' active' : ''}`}
            onClick={() => {
              if (topMode !== 'blur') {
                setTopMode('blur');
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
            <svg className={`blur-tab-chevron${topMode === 'blur' ? ' active' : ''}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
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
                  onClick={(e) => { e.stopPropagation(); setTopMode('blur'); setBlurSubMode(opt.value); setBlurPickerOpen(false); }}
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
      backAction={() => batchDirtyRef.current ? setShowConfirmBack(true) : onBack()}
      backLabel="Back"
      primaryAction={handleDone}
      primaryLabel="Done"
      toolbarClassName="screen-bottom-toolbar--mask-editor"
      toolbar={toolbarContent}
    >
      <div
        ref={containerRef}
        className="mask-editor-canvas-container"
        onTouchStart={onContainerTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onMouseMove={(e) => setCursorPos({ x: e.clientX, y: e.clientY })}
        onMouseLeave={() => setCursorPos(null)}
      >
        <div
          className="mask-editor-zoom-wrapper"
          style={{ transform: getTransformStyle(), transformOrigin: 'center center' }}
        >
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <canvas
              ref={canvasRef}
              className="mask-editor-canvas"
              aria-label="Batch blur editor canvas"
              style={{ cursor: (topMode === 'tattoo' || blurSubMode === 'freehand') ? 'none' : undefined, touchAction: 'none' }}
              onPointerDown={topMode === 'tattoo' ? onTattooDown : (blurSubMode === 'freehand' ? onFaceBlurDown : onShapeCanvasDown)}
            />
            {topMode === 'blur' && editDets.map((det, i) => (
              <div
                key={`face-${i}`}
                className={`face-overlay${selectedIdx === i ? ' selected' : ''}${det.shape === 'rectangle' ? ' rectangle' : ''}${!det.enabled ? ' face-overlay-disabled' : ''}`}
                style={{
                  position: 'absolute',
                  left: `${(det.topLeft[0] / imgW) * 100}%`,
                  top: `${(det.topLeft[1] / imgH) * 100}%`,
                  width: `${((det.bottomRight[0] - det.topLeft[0]) / imgW) * 100}%`,
                  height: `${((det.bottomRight[1] - det.topLeft[1]) / imgH) * 100}%`,
                  pointerEvents: blurSubMode !== 'freehand' ? 'auto' : 'none',
                }}
                onPointerDown={blurSubMode !== 'freehand' ? (e) => handleFaceDragDown(e, i) : undefined}
              >
                <svg className="face-overlay-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="5 9 2 12 5 15" />
                  <polyline points="9 5 12 2 15 5" />
                  <polyline points="15 19 12 22 9 19" />
                  <polyline points="19 9 22 12 19 15" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <line x1="12" y1="2" x2="12" y2="22" />
                </svg>
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
              </div>
            ))}
          </div>
        </div>

        {/* Custom brush cursor for freehand blur and tattoo modes */}
        {(topMode === 'tattoo' || blurSubMode === 'freehand') && cursorPos && (
          <div
            className={`brush-cursor${faceBlurTool === 'eraser' ? ' brush-cursor--eraser' : ''} brush-cursor-preview`}
            style={{
              left: cursorPos.x,
              top: cursorPos.y,
              width: faceBlurBrushSize,
              height: faceBlurBrushSize,
            }}
          />
        )}
      </div>
      {showConfirmBack && (
        <ConfirmModal
          title="Discard edits?"
          message="You have unsaved changes. Going back will discard them."
          confirmLabel="Discard"
          onConfirm={onBack}
          onCancel={() => setShowConfirmBack(false)}
        />
      )}
    </ScreenShell>
  );
}
