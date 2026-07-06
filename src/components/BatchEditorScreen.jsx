import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useBatch } from '../context/BatchContext';
import { useZoomPan } from '../hooks/useZoomPan';
import { applyMaskedBlur, stackBlur, BLUR_MODE_LABELS, BAR_STYLES, migrateBlurSettings, drawRegionMask } from '../utils/blurEngine';
import ColorSpectrumPicker from './ColorSpectrumPicker';
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
  const [localStickerEnabled, setLocalStickerEnabled] = useState(false);
  const [localStrength, setLocalStrength] = useState(20);
  const [localFeather, setLocalFeather] = useState(0);
  const [localBarWidth, setLocalBarWidth] = useState(20);
  const [localBarLength, setLocalBarLength] = useState(110);
  const [localBarAngle, setLocalBarAngle] = useState(0);
  const [localBarStyle, setLocalBarStyle] = useState('solid');
  const [localBarColor, setLocalBarColor] = useState('#000000');
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
  }, [batchDirtyRef, editDets, localMode, localStickerEnabled, localStrength, localFeather, localBarWidth, localBarLength, localBarAngle, localBarStyle, localBarColor]);
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
  const [barStyleMenuOpen, setBarStyleMenuOpen] = useState(false);
  const [barColorPickerOpen, setBarColorPickerOpen] = useState(false);
  const [barStyleMenuPos, setBarStyleMenuPos] = useState(null);
  const barStyleMenuRef = useRef(null);
  const barStyleTriggerRef = useRef(null);
  const barStyleMenuElRef = useRef(null);

  // Keep refs in sync for rAF callbacks
  const editDetsRef = useRef(editDets);
  const localModeRef = useRef(localMode);
  const localStickerEnabledRef = useRef(localStickerEnabled);
  const localStrengthRef = useRef(localStrength);
  const localFeatherRef = useRef(localFeather);
  const localBarWidthRef = useRef(localBarWidth);
  const localBarLengthRef = useRef(localBarLength);
  const localBarAngleRef = useRef(localBarAngle);
  const localBarStyleRef = useRef(localBarStyle);
  const localBarColorRef = useRef(localBarColor);
  useEffect(() => { editDetsRef.current = editDets; }, [editDets]);
  useEffect(() => { localModeRef.current = localMode; }, [localMode]);
  useEffect(() => { localStickerEnabledRef.current = localStickerEnabled; }, [localStickerEnabled]);
  useEffect(() => { localStrengthRef.current = localStrength; }, [localStrength]);
  useEffect(() => { localFeatherRef.current = localFeather; }, [localFeather]);
  useEffect(() => { localBarWidthRef.current = localBarWidth; }, [localBarWidth]);
  useEffect(() => { localBarLengthRef.current = localBarLength; }, [localBarLength]);
  useEffect(() => { localBarAngleRef.current = localBarAngle; }, [localBarAngle]);
  useEffect(() => { localBarStyleRef.current = localBarStyle; }, [localBarStyle]);
  useEffect(() => { localBarColorRef.current = localBarColor; }, [localBarColor]);
  useEffect(() => { faceBlurToolRef.current = faceBlurTool; }, [faceBlurTool]);
  useEffect(() => { faceBlurBrushSizeRef.current = faceBlurBrushSize; }, [faceBlurBrushSize]);
  useEffect(() => () => clearTimeout(touchDelayRef.current), []);

  const forceRender = useCallback(() => setRenderKey(k => k + 1), []);

  // Close popovers on outside click
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

  // Initialize local state from batch entry
  useEffect(() => {
    if (!imageEntry) return;
    const dets = imageEntry.editDetections || imageEntry.detections || [];
    setEditDets(dets.map(d => ({
      ...d,
      kind: d.kind || 'blur',
      enabled: d.enabled !== false,
      origHw: d.origHw || (d.bottomRight[0] - d.topLeft[0]) / 2,
      origHh: d.origHh || (d.bottomRight[1] - d.topLeft[1]) / 2,
    })));
    const settings = migrateBlurSettings(imageEntry.blurSettings || globalBlurSettings);
    setLocalMode(settings.mode);
    setLocalStickerEnabled(!!settings.stickerEnabled);
    setLocalStrength(settings.strength);
    setLocalFeather(imageEntry.localFeather ?? globalFeather);
    setLocalBarWidth(settings.barWidth ?? globalBlurSettings.barWidth ?? 20);
    setLocalBarLength(settings.barLength ?? globalBlurSettings.barLength ?? 110);
    setLocalBarAngle(settings.barAngle ?? globalBlurSettings.barAngle ?? 0);
    setLocalBarStyle(settings.barStyle ?? globalBlurSettings.barStyle ?? 'solid');
    setLocalBarColor(settings.barColor ?? globalBlurSettings.barColor ?? '#000000');
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

  // Auto/Shape always need a real blur type; Freehand "Colors" sets 'none'.
  useEffect(() => {
    if ((blurSubMode === 'autoface' || blurSubMode === 'shape') && localMode === 'none') {
      setLocalMode('gaussian');
    }
  }, [blurSubMode, localMode]);

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
        if (det.kind === 'sticker') continue; // stickers aren't blur regions
        drawRegionMask(ctx, det);
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
    const stickerEnabled = !!localStickerEnabledRef.current; // freehand color flag
    const strength = localStrengthRef.current;
    const wantBlur = mode === 'gaussian' || mode === 'pixelate';

    const blurDets = dets.filter(d => d.kind !== 'sticker');
    const stickerObjects = dets.filter(d => d.kind === 'sticker');

    const blurMask = wantBlur ? buildPreviewMask(blurDets, 'gaussian') : null;
    const freehandStickerMask = stickerEnabled ? buildPreviewMask([], 'blackbar') : null;

    const hasPixels = (m) => {
      const d = m.getContext('2d').getImageData(0, 0, m.width, m.height).data;
      for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) return true; }
      return false;
    };
    const hasBlur = !!blurMask && hasPixels(blurMask);
    const hasSticker = stickerObjects.length > 0 || (!!freehandStickerMask && hasPixels(freehandStickerMask));

    // Free the previous preview's bitmap before replacing it.
    const prev = blurPreviewRef.current;
    if (prev) { prev.width = 0; prev.height = 0; }

    if (!hasBlur && !hasSticker) {
      blurPreviewRef.current = null;
    } else {
      blurPreviewRef.current = applyMaskedBlur(
        src, blurMask, wantBlur ? mode : 'none', strength,
        stickerObjects, freehandStickerMask, localBarColorRef.current || '#000000',
      );
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

  useEffect(() => { scheduleBlurPreview(); }, [editDets, localMode, localStickerEnabled, localStrength, localFeather, localBarWidth, localBarLength, localBarAngle, localBarStyle, localBarColor]);

  // Render display canvas
  const renderDisplay = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !src) return;
    // Only resize when dimensions actually change — assigning canvas.width/height
    // reallocates + zero-fills the whole backing store (~48 MB at 12 MP) and was
    // a primary cause of paint lag on large images. The image is fully repainted
    // below, so skipping the reset leaves no stale pixels.
    if (canvas.width !== imgW || canvas.height !== imgH) {
      canvas.width = imgW;
      canvas.height = imgH;
    }
    const ctx = canvas.getContext('2d');

    // Base layer: the blur preview when one's been computed, otherwise the
    // raw source. Shown regardless of which tab is active — if the user has
    // auto-detected a face and then switched to the Tattoo tab, dropping the
    // blur looks like their work was lost (the underlying state is still
    // there; this is a display-only concern). The tattoo mask tint overlays
    // on top, so both pieces of their work stay visible at once.
    if (blurPreviewRef.current) {
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
      tintedMaskRef.current = tinted;
      // Only reallocate the tint buffer on a real size change; clearRect below
      // handles per-frame clearing.
      if (tinted.width !== imgW || tinted.height !== imgH) {
        tinted.width = imgW;
        tinted.height = imgH;
      }
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
  }, [src, imgW, imgH]);

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

  // --- Corner-handle resize (free 2-D) ---
  // Each corner moves independently, opposite corner pinned, min-size clamp.
  // origHw/origHh re-synced so nothing downstream relies on a stale base.
  const handleResizeDown = useCallback((e, index, corner) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedIdx(index);
    const dets = editDetsRef.current;
    const origTL = [...dets[index].topLeft];
    const origBR = [...dets[index].bottomRight];
    const MIN = Math.max(8, imgW * 0.02);

    const onMove = (ev) => {
      ev.preventDefault();
      const p = screenToImage(ev.clientX, ev.clientY, canvasRef.current);
      let [l, t] = origTL;
      let [r, b] = origBR;
      if (corner.includes('w')) l = Math.min(p.x, r - MIN);
      if (corner.includes('e')) r = Math.max(p.x, l + MIN);
      if (corner.includes('n')) t = Math.min(p.y, b - MIN);
      if (corner.includes('s')) b = Math.max(p.y, t + MIN);
      setEditDets(prev => {
        const next = [...prev];
        next[index] = {
          ...next[index],
          topLeft: [l, t],
          bottomRight: [r, b],
          origHw: (r - l) / 2,
          origHh: (b - t) / 2,
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
  }, [screenToImage, forceRender, imgW]);

  // Remove a detection
  const handleRemoveFace = useCallback((idx) => {
    setEditDets(prev => prev.filter((_, i) => i !== idx));
    setSelectedIdx(null);
  }, []);

  // Add a blur region — oval or rectangle (rect starts a touch wider/bar-like).
  const handleAddRegion = useCallback((shape) => {
    const hw = imgW * (shape === 'rect' ? 0.11 : 0.075);
    const hh = shape === 'rect' ? imgW * 0.05 : hw * 1.3;
    const cx = imgW / 2;
    const cy = imgH / 2;
    setEditDets(prev => [...prev, {
      kind: 'blur',
      shape,
      topLeft: [cx - hw, cy - hh],
      bottomRight: [cx + hw, cy + hh],
      origHw: hw,
      origHh: hh,
      enabled: true,
      type: 'manual',
    }]);
    setSelectedIdx(editDetsRef.current.length);
  }, [imgW, imgH]);

  // Add a sticker object (independent; defaults from current local settings)
  const handleAddSticker = useCallback(() => {
    const hw = imgW * 0.12;
    const hh = imgW * 0.035;
    const cx = imgW / 2;
    const cy = imgH / 2;
    setEditDets(prev => [...prev, {
      kind: 'sticker',
      topLeft: [cx - hw, cy - hh],
      bottomRight: [cx + hw, cy + hh],
      origHw: hw,
      origHh: hh,
      enabled: true,
      type: 'manual',
      barStyle: localBarStyleRef.current || 'solid',
      barColor: localBarColorRef.current || '#000000',
      barWidth: 100,
      barLength: 100,
      barAngle: 0,
    }]);
    setSelectedIdx(editDetsRef.current.length);
  }, [imgW, imgH]);

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
    const blurDets = enabledDets.filter(d => d.kind !== 'sticker');
    const stickerObjects = enabledDets.filter(d => d.kind === 'sticker');
    const wantBlur = localMode === 'gaussian' || localMode === 'pixelate';
    const blurMask = wantBlur ? buildPreviewMask(blurDets, 'gaussian') : null;
    const freehandStickerMask = localStickerEnabled ? buildPreviewMask([], 'blackbar') : null;

    const hasPixels = (m) => {
      const d = m.getContext('2d').getImageData(0, 0, m.width, m.height).data;
      for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) return true; }
      return false;
    };
    const hasBlur = !!blurMask && hasPixels(blurMask);
    const hasSticker = stickerObjects.length > 0 || (!!freehandStickerMask && hasPixels(freehandStickerMask));

    let previewCanvas = null;
    if (hasBlur || hasSticker) {
      previewCanvas = applyMaskedBlur(
        src, blurMask, wantBlur ? localMode : 'none', localStrength,
        stickerObjects, freehandStickerMask, localBarColor || '#000000',
      );
    }

    const thumbSource = previewCanvas || src;
    const thumbnailCanvas = createThumbnail(thumbSource);
    if (imageEntry.thumbnailUrl) URL.revokeObjectURL(imageEntry.thumbnailUrl);
    const thumbnailUrl = await canvasToBlobUrl(thumbnailCanvas);

    updateImage(imageEntry.id, {
      editDetections: editDets,
      blurSettings: { mode: localMode, stickerEnabled: localStickerEnabled, strength: localStrength, barWidth: localBarWidth, barLength: localBarLength, barAngle: localBarAngle, barStyle: localBarStyle, barColor: localBarColor },
      localFeather: localFeather,
      faceBlurCanvas: faceBlurCanvasRef.current,
      tattooMaskCanvas: tattooMaskCanvasRef.current,
      status: 'edited',
      thumbnailCanvas,
      thumbnailUrl,
    });
    onBack();
  }, [imageEntry, src, editDets, localMode, localStickerEnabled, localStrength, localFeather, localBarWidth, localBarLength, localBarAngle, localBarStyle, localBarColor, buildPreviewMask, updateImage, onBack]);

  if (!imageEntry || !src) {
    return (
      <ScreenShell backAction={onBack} backLabel="Back" stepLabel="Editing">
        <div className="batch-editor-empty" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: 'var(--text-dim)' }}>Image not found</div>
      </ScreenShell>
    );
  }

  // Blur type + current-sticker selector. Gaussian / Pixelate pick the blur
  // TYPE (always one active in Auto/Shape). The Stickers dropdown picks the
  // style/color of the SELECTED sticker, or the default for the next Add
  // Sticker. Freehand keeps its exclusive brush picker. Mirrors MaskEditorScreen.
  const isFreehand = blurSubMode === 'freehand';
  const selectedDet = selectedIdx !== null ? editDets[selectedIdx] : null;
  const selectedSticker = selectedDet && selectedDet.kind === 'sticker' ? selectedDet : null;
  const stickerOn = !!localStickerEnabled; // freehand color-brush flag
  const curStickerStyle = selectedSticker ? (selectedSticker.barStyle || 'solid') : (localBarStyle || 'solid');
  const curStickerColor = selectedSticker ? (selectedSticker.barColor || '#000000') : (localBarColor || '#000000');
  const activeBarStyle = BAR_STYLES.find((s) => s.key === curStickerStyle) || BAR_STYLES[0];
  const barLabel = isFreehand ? 'Stickers' : activeBarStyle.label;

  const updateSelectedSticker = (patch) => {
    if (selectedSticker) {
      setEditDets((prev) => prev.map((d, i) => (i === selectedIdx ? { ...d, ...patch } : d)));
    }
    if ('barStyle' in patch) setLocalBarStyle(patch.barStyle);
    if ('barColor' in patch) setLocalBarColor(patch.barColor);
    if ('barWidth' in patch) setLocalBarWidth(patch.barWidth);
    if ('barLength' in patch) setLocalBarLength(patch.barLength);
    if ('barAngle' in patch) setLocalBarAngle(patch.barAngle);
  };

  const blurDropdownJSX = (
    <div className="blur-style-row" role="radiogroup" aria-label="Blur style">
      {[
        { value: 'gaussian', label: 'Gaussian' },
        { value: 'pixelate', label: 'Pixelate' },
      ].map((opt) => {
        const isSelected = localMode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            className={`blur-style-btn${isSelected ? ' is-selected' : ''}`}
            onClick={() => {
              setBarStyleMenuOpen(false);
              if (isFreehand) {
                // Freehand: blur and color brush are mutually exclusive.
                setLocalMode(opt.value);
                setLocalStickerEnabled(false);
              } else {
                // Auto/Shape: just the blur type (always one active).
                setLocalMode(opt.value);
              }
            }}
          >
            {opt.label}
          </button>
        );
      })}
      <div className="bar-style-menu-wrap" ref={barStyleMenuRef}>
        {isFreehand ? (
          <button
            ref={barStyleTriggerRef}
            type="button"
            role="radio"
            aria-checked={stickerOn}
            className={`blur-style-btn bar-style-trigger${stickerOn ? ' is-selected' : ''}`}
            onClick={() => {
              setLocalMode('none');
              setLocalStickerEnabled(true);
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

  const wantBlurControls = localMode === 'gaussian' || localMode === 'pixelate';
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
          </>
        )}
      </div>
      {/* Size is set by dragging the on-canvas corner handles; only rotation
          (which handles can't express) keeps a slider. */}
      {selectedSticker && (
        <div className="toolbar-row">
          <div className="toolbar-group toolbar-group-slider">
            <label className="toolbar-slider">
              <span>Angle</span>
              <input type="range" min="-45" max="45" value={selectedSticker.barAngle ?? 0}
                onChange={(e) => updateSelectedSticker({ barAngle: parseInt(e.target.value, 10) })} />
            </label>
          </div>
        </div>
      )}
    </>
  );

  const selectedBlurRegionRow = selectedIdx !== null && editDets[selectedIdx] ? (
    <div className="toolbar-row oval-resize-row">
      <div className="toolbar-group toolbar-group-inline">
        <span className="toolbar-label">
          {selectedSticker
            ? 'Sticker'
            : blurSubMode === 'autoface'
              ? 'Face'
              : (editDets[selectedIdx]?.shape === 'rect' ? 'Rectangle' : 'Oval')} {selectedIdx + 1}
        </span>
      </div>
      <div className="toolbar-group toolbar-group-inline oval-resize-hint">
        <span className="toolbar-hint">Drag the corner handles to resize</span>
      </div>
      <div className="toolbar-group toolbar-group-inline">
        <button className="tool-btn" onClick={() => handleRemoveFace(selectedIdx)}
          title="Remove selected">
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
            <h3 className="mode-panel-title">Tattoo Removal</h3>
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
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0 8.4-2.245c0-.399-.078-.78-.22-1.128Zm0 0a15.998 15.998 0 0 0 3.388-1.62m-5.043-.025a15.994 15.994 0 0 1 1.622-3.395m3.42 3.42a15.995 15.995 0 0 0 4.764-4.648l3.876-5.814a1.151 1.151 0 0 0-1.597-1.597L14.146 6.32a15.996 15.996 0 0 0-4.649 4.763m3.42 3.42a6.776 6.776 0 0 0-3.42-3.42" />
                  </svg>
                  Paint
                </button>
                <button className={`tool-btn ${faceBlurTool === 'eraser' ? 'active' : ''}`}
                  onClick={() => setFaceBlurTool('eraser')} title="Erase painted tattoo mask">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
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
            <h3 className="mode-panel-title">Manual Blur</h3>
            {blurAdjustmentsRow}
            {selectedBlurRegionRow}
            <div className="toolbar-row">
              <div className="toolbar-group toolbar-group-buttons">
                <button className="tool-btn" onClick={() => handleAddRegion('oval')} title="Add an oval blur region">
                  + Oval
                </button>
                <button className="tool-btn" onClick={() => handleAddRegion('rect')} title="Add a rectangular blur region">
                  + Rectangle
                </button>
                <button className="tool-btn" onClick={handleAddSticker} title="Add a sticker">
                  + Sticker
                </button>
              </div>
            </div>
          </div>
        )}

        {topMode === 'blur' && blurSubMode === 'autoface' && (
          <div className="toolbar-panel mask-editor-toolbar-panel">
            <h3 className="mode-panel-title">Auto Blur</h3>
            {blurAdjustmentsRow}
            {selectedBlurRegionRow}
            <div className="toolbar-row">
              <div className="toolbar-group toolbar-group-buttons">
                <button className="tool-btn" onClick={handleAddSticker} title="Add a sticker">
                  + Sticker
                </button>
                <button className="tool-btn" onClick={handleClearFaces} title="Clear all blur regions">
                  Clear All
                </button>
              </div>
            </div>
          </div>
        )}

        {topMode === 'blur' && blurSubMode === 'freehand' && (
          <div className="toolbar-panel mask-editor-toolbar-panel">
            <h3 className="mode-panel-title">Freehand Blur</h3>
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
            {wantBlurControls && (
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
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0 8.4-2.245c0-.399-.078-.78-.22-1.128Zm0 0a15.998 15.998 0 0 0 3.388-1.62m-5.043-.025a15.994 15.994 0 0 1 1.622-3.395m3.42 3.42a15.995 15.995 0 0 0 4.764-4.648l3.876-5.814a1.151 1.151 0 0 0-1.597-1.597L14.146 6.32a15.996 15.996 0 0 0-4.649 4.763m3.42 3.42a6.776 6.776 0 0 0-3.42-3.42" />
                  </svg>
                  Paint
                </button>
                <button className={`tool-btn ${faceBlurTool === 'eraser' ? 'active' : ''}`}
                  onClick={() => setFaceBlurTool('eraser')} title="Erase painted blur regions">
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

      {/* Level 1: Top-mode tabs — Blur (left) + Tattoo Removal (right),
          matching the Redact.ID single-image editor layout. */}
      <div className="toolbar-tabs">
        <div className="toolbar-tab-wrapper" ref={blurTabRef}>
          <button className={`toolbar-tab${topMode === 'blur' ? ' active' : ''}`}
            onClick={() => {
              if (topMode !== 'blur') {
                setTopMode('blur');
              } else {
                setBlurPickerOpen(v => !v);
              }
            }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7.5 3.75H6A2.25 2.25 0 0 0 3.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0 1 20.25 6v1.5m0 9V18A2.25 2.25 0 0 1 18 20.25h-1.5m-9 0H6A2.25 2.25 0 0 1 3.75 18v-1.5M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            </svg>
            {{ autoface: 'Auto Blur', shape: 'Manual Blur', freehand: 'Freehand Blur' }[blurSubMode]}
            <svg className={`blur-tab-chevron${topMode === 'blur' ? ' active' : ''}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
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
                { value: 'shape', label: 'Manual Blur', icon: (
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
                  onClick={(e) => { e.stopPropagation(); setTopMode('blur'); setBlurSubMode(opt.value); setBlurPickerOpen(false); }}
                >
                  {opt.icon}
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button ref={tattooTabRef}
          className={`toolbar-tab${topMode === 'tattoo' ? ' active' : ''}`}
          onClick={() => { setTopMode('tattoo'); setBlurPickerOpen(false); setSelectedIdx(null); }}>
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
                className={`face-overlay${selectedIdx === i ? ' selected' : ''}${det.kind === 'sticker' ? ' sticker-overlay' : ''}${det.kind !== 'sticker' && det.shape === 'rect' ? ' rect-overlay' : ''}${!det.enabled ? ' face-overlay-disabled' : ''}`}
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
                {blurSubMode !== 'freehand' && selectedIdx === i && ['nw', 'ne', 'sw', 'se'].map((corner) => (
                  <div
                    key={corner}
                    className={`face-overlay-handle handle-${corner}`}
                    onPointerDown={(e) => handleResizeDown(e, i, corner)}
                  />
                ))}
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
