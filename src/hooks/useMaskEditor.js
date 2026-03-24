import { useRef, useState, useCallback } from 'react';
import { computeEdgeMap, computeInkMap } from '../utils/edgeDetection';

const MAX_HISTORY = 20;

export function useMaskEditor(tattooMaskCanvasRef, exclusionMaskCanvasRef, samScaleRef, imageWidth, imageHeight, detections, onMaskChange, coordMapper) {
  const [activeTool, setActiveTool] = useState('brush');
  const [brushSize, setBrushSize] = useState(50);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [edgeSnap, setEdgeSnap] = useState(false);
  const [inkSensitivity, setInkSensitivity] = useState(50);
  const [brushTarget, setBrushTarget] = useState('tattoo'); // 'tattoo' | 'exclude'

  const isDrawing = useRef(false);
  const lastPos = useRef(null);
  const historyStack = useRef([]);
  const historyIndex = useRef(-1);
  const edgeMapRef = useRef(null);
  const inkMapRef = useRef(null);
  const srcPixelsRef = useRef(null);

  // --- History ---
  const updateHistoryDepth = useCallback(() => {
    setUndoCount(Math.max(0, historyIndex.current));
    setRedoCount(Math.max(0, historyStack.current.length - 1 - historyIndex.current));
  }, []);

  const saveToHistory = useCallback(() => {
    const mask = tattooMaskCanvasRef.current;
    if (!mask) return;
    const ctx = mask.getContext('2d');
    const data = ctx.getImageData(0, 0, mask.width, mask.height);
    historyStack.current = historyStack.current.slice(0, historyIndex.current + 1);
    historyStack.current.push(data);
    if (historyStack.current.length > MAX_HISTORY) historyStack.current.shift();
    historyIndex.current = historyStack.current.length - 1;
    setCanUndo(historyIndex.current > 0);
    setCanRedo(false);
    updateHistoryDepth();
  }, [tattooMaskCanvasRef, updateHistoryDepth]);

  const undo = useCallback(() => {
    if (historyIndex.current <= 0) return;
    historyIndex.current--;
    const mask = tattooMaskCanvasRef.current;
    if (!mask) return;
    mask.getContext('2d').putImageData(historyStack.current[historyIndex.current], 0, 0);
    setCanUndo(historyIndex.current > 0);
    setCanRedo(true);
    updateHistoryDepth();
    onMaskChange?.();
  }, [tattooMaskCanvasRef, onMaskChange, updateHistoryDepth]);

  const redo = useCallback(() => {
    if (historyIndex.current >= historyStack.current.length - 1) return;
    historyIndex.current++;
    const mask = tattooMaskCanvasRef.current;
    if (!mask) return;
    mask.getContext('2d').putImageData(historyStack.current[historyIndex.current], 0, 0);
    setCanUndo(true);
    setCanRedo(historyIndex.current < historyStack.current.length - 1);
    updateHistoryDepth();
    onMaskChange?.();
  }, [tattooMaskCanvasRef, onMaskChange, updateHistoryDepth]);

  const initHistory = useCallback(() => {
    historyStack.current = [];
    historyIndex.current = -1;
    saveToHistory();
    updateHistoryDepth();
  }, [saveToHistory, updateHistoryDepth]);

  const clearMask = useCallback(() => {
    const mask = tattooMaskCanvasRef.current;
    if (!mask) return;
    mask.getContext('2d').clearRect(0, 0, mask.width, mask.height);
    saveToHistory();
    updateHistoryDepth();
  }, [tattooMaskCanvasRef, saveToHistory, updateHistoryDepth]);

  // --- Edge map + ink map ---
  const initEdgeMap = useCallback((sourceCanvas) => {
    edgeMapRef.current = computeEdgeMap(sourceCanvas);
    inkMapRef.current = computeInkMap(sourceCanvas);
    srcPixelsRef.current = sourceCanvas.getContext('2d').getImageData(0, 0, sourceCanvas.width, sourceCanvas.height).data;
    console.log(`[MaskEditor] Edge map computed: ${sourceCanvas.width}x${sourceCanvas.height}`);
  }, []);

  // --- Canvas position helper ---
  const getCanvasPos = useCallback((e, canvas) => {
    if (coordMapper) {
      const clientX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
      const clientY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
      return coordMapper(clientX, clientY, canvas);
    }
    const rect = canvas.getBoundingClientRect();
    const scaleX = imageWidth / rect.width;
    const scaleY = imageHeight / rect.height;
    let clientX, clientY;
    if (e.touches) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }, [imageWidth, imageHeight, coordMapper]);

  // --- Brush/Eraser strokes ---
  const drawStroke = useCallback((from, to, tool, size) => {
    const activeRef = brushTarget === 'exclude' ? exclusionMaskCanvasRef : tattooMaskCanvasRef;
    const mask = activeRef.current;
    if (!mask) return;
    const ctx = mask.getContext('2d');

    // Standard stroke for eraser or when edge snap is off
    if (tool === 'eraser' || !edgeSnap || !edgeMapRef.current) {
      ctx.lineWidth = size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (tool === 'eraser') {
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
      return;
    }

    // Ink-only painting: only mask pixels that look like tattoo ink, skip skin & background
    const inkData = inkMapRef.current;
    const inkMap = inkData?.map;
    const bodyMask = inkData?.bodyMask;
    const iw = inkData?.width || 0;
    const fx = from?.x ?? to.x;
    const fy = from?.y ?? to.y;
    const dx = to.x - fx;
    const dy = to.y - fy;
    const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const steps = Math.ceil(dist / 2);
    const r = size / 2;
    const r2 = r * r;
    // Sensitivity 0→threshold 0.6 (conservative), 50→0.25 (default), 100→0.02 (aggressive)
    const INK_THRESHOLD = 0.6 - (inkSensitivity / 100) * 0.58;

    const maskData = ctx.getImageData(0, 0, mask.width, mask.height);
    const pixels = maskData.data;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = fx + dx * t;
      const cy = fy + dy * t;

      const minX = Math.max(0, Math.floor(cx - r));
      const maxX = Math.min(mask.width - 1, Math.ceil(cx + r));
      const minY = Math.max(0, Math.floor(cy - r));
      const maxY = Math.min(mask.height - 1, Math.ceil(cy + r));

      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const ddx = px - cx;
          const ddy = py - cy;
          if (ddx * ddx + ddy * ddy > r2) continue;

          // Skip background pixels (no skin nearby)
          if (bodyMask && iw > 0 && !bodyMask[py * iw + px]) continue;
          // Skip very bright pixels (white background/fabric)
          if (srcPixelsRef.current) {
            const si = (py * iw + px) * 4;
            const brightness = srcPixelsRef.current[si] * 0.299 + srcPixelsRef.current[si + 1] * 0.587 + srcPixelsRef.current[si + 2] * 0.114;
            if (brightness > 230) continue;
          }
          // Only paint if this pixel looks like ink
          if (inkMap && iw > 0) {
            const inkScore = inkMap[py * iw + px];
            if (inkScore < INK_THRESHOLD) continue;
          }

          const pidx = (py * mask.width + px) * 4;
          pixels[pidx] = 255;
          pixels[pidx + 1] = 255;
          pixels[pidx + 2] = 255;
          pixels[pidx + 3] = 255;
        }
      }
    }

    ctx.putImageData(maskData, 0, 0);
  }, [tattooMaskCanvasRef, exclusionMaskCanvasRef, brushTarget, edgeSnap, inkSensitivity]);

  // --- Pointer event handlers ---
  const handlePointerDown = useCallback((e, canvasEl) => {
    const pos = getCanvasPos(e, canvasEl);
    isDrawing.current = true;
    lastPos.current = pos;
    drawStroke(null, pos, activeTool, brushSize);
  }, [activeTool, brushSize, getCanvasPos, drawStroke]);

  const handlePointerMove = useCallback((e, canvasEl) => {
    if (!isDrawing.current) return;
    const pos = getCanvasPos(e, canvasEl);
    drawStroke(lastPos.current, pos, activeTool, brushSize);
    lastPos.current = pos;
  }, [activeTool, brushSize, getCanvasPos, drawStroke]);

  const handlePointerUp = useCallback(() => {
    if (!isDrawing.current) return;
    isDrawing.current = false;
    lastPos.current = null;
    if (brushTarget === 'tattoo') saveToHistory();
  }, [saveToHistory, brushTarget]);

  const clearExclusion = useCallback(() => {
    const ex = exclusionMaskCanvasRef.current;
    if (!ex) return;
    ex.getContext('2d').clearRect(0, 0, ex.width, ex.height);
  }, [exclusionMaskCanvasRef]);

  return {
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
    edgeSnap, setEdgeSnap,
    inkSensitivity, setInkSensitivity,
    initEdgeMap,
    brushTarget, setBrushTarget,
    clearExclusion,
  };
}
