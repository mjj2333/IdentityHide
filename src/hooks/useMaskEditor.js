import { useRef, useState, useCallback } from 'react';

const MAX_HISTORY = 15;

// Store alpha channel only — 4x smaller than full ImageData
function snapshotAlpha(ctx, w, h) {
  const src = ctx.getImageData(0, 0, w, h).data;
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = src[i * 4 + 3];
  }
  return alpha;
}

// Restore mask from alpha-only snapshot
function restoreAlpha(ctx, alpha, w, h) {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i];
    const j = i * 4;
    d[j] = a > 0 ? 255 : 0;
    d[j + 1] = a > 0 ? 255 : 0;
    d[j + 2] = a > 0 ? 255 : 0;
    d[j + 3] = a;
  }
  ctx.putImageData(img, 0, 0);
}

export function useMaskEditor(tattooMaskCanvasRef, samScaleRef, imageWidth, imageHeight, detections, onMaskChange, coordMapper) {
  const [activeTool, setActiveTool] = useState('brush');
  const [brushSize, setBrushSize] = useState(50);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);

  const isDrawing = useRef(false);
  const lastPos = useRef(null);
  const historyStack = useRef([]);
  const historyIndex = useRef(-1);

  // --- History ---
  const updateHistoryDepth = useCallback(() => {
    setUndoCount(Math.max(0, historyIndex.current));
    setRedoCount(Math.max(0, historyStack.current.length - 1 - historyIndex.current));
  }, []);

  const saveToHistory = useCallback(() => {
    const mask = tattooMaskCanvasRef.current;
    if (!mask) return;
    const ctx = mask.getContext('2d');
    const alpha = snapshotAlpha(ctx, mask.width, mask.height);
    historyStack.current = historyStack.current.slice(0, historyIndex.current + 1);
    historyStack.current.push(alpha);
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
    restoreAlpha(mask.getContext('2d'), historyStack.current[historyIndex.current], mask.width, mask.height);
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
    restoreAlpha(mask.getContext('2d'), historyStack.current[historyIndex.current], mask.width, mask.height);
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
    const mask = tattooMaskCanvasRef.current;
    if (!mask) return;
    const ctx = mask.getContext('2d');

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
  }, [tattooMaskCanvasRef]);

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
    saveToHistory();
  }, [saveToHistory]);

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
  };
}
