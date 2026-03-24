import { useRef, useCallback, useEffect, useState } from 'react';

const MAX_HISTORY = 20;

export function useCanvas(maskCanvasRef, onMaskChange) {
  const interactiveCanvasRef = useRef(null);
  const isDrawing = useRef(false);
  const lastPos = useRef(null);
  const historyStack = useRef([]);
  const historyIndex = useRef(-1);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Save current mask state to history
  const saveToHistory = useCallback(() => {
    const mask = maskCanvasRef.current;
    if (!mask) return;
    const ctx = mask.getContext('2d');
    const data = ctx.getImageData(0, 0, mask.width, mask.height);

    // Truncate redo stack
    historyStack.current = historyStack.current.slice(0, historyIndex.current + 1);
    historyStack.current.push(data);

    // Cap history size
    if (historyStack.current.length > MAX_HISTORY) {
      historyStack.current.shift();
    }
    historyIndex.current = historyStack.current.length - 1;
    setCanUndo(historyIndex.current > 0);
    setCanRedo(false);
  }, [maskCanvasRef]);

  const undo = useCallback(() => {
    if (historyIndex.current <= 0) return;
    historyIndex.current--;
    const mask = maskCanvasRef.current;
    if (!mask) return;
    const ctx = mask.getContext('2d');
    ctx.putImageData(historyStack.current[historyIndex.current], 0, 0);
    setCanUndo(historyIndex.current > 0);
    setCanRedo(true);
    onMaskChange?.();
  }, [maskCanvasRef, onMaskChange]);

  const redo = useCallback(() => {
    if (historyIndex.current >= historyStack.current.length - 1) return;
    historyIndex.current++;
    const mask = maskCanvasRef.current;
    if (!mask) return;
    const ctx = mask.getContext('2d');
    ctx.putImageData(historyStack.current[historyIndex.current], 0, 0);
    setCanUndo(true);
    setCanRedo(historyIndex.current < historyStack.current.length - 1);
    onMaskChange?.();
  }, [maskCanvasRef, onMaskChange]);

  // Initialize history with current mask state
  const initHistory = useCallback(() => {
    historyStack.current = [];
    historyIndex.current = -1;
    saveToHistory();
  }, [saveToHistory]);

  const getCanvasPos = useCallback((e, canvas) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

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
  }, []);

  const drawStroke = useCallback((from, to, tool, size) => {
    const mask = maskCanvasRef.current;
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

    // Reset composite operation
    ctx.globalCompositeOperation = 'source-over';
  }, [maskCanvasRef]);

  const handlePointerDown = useCallback((e, tool, size) => {
    const canvas = e.currentTarget;
    isDrawing.current = true;
    const pos = getCanvasPos(e, canvas);
    lastPos.current = pos;
    drawStroke(null, pos, tool, size);
    onMaskChange?.();
  }, [getCanvasPos, drawStroke, onMaskChange]);

  const handlePointerMove = useCallback((e, tool, size) => {
    if (!isDrawing.current) return;
    const canvas = e.currentTarget;
    const pos = getCanvasPos(e, canvas);
    drawStroke(lastPos.current, pos, tool, size);
    lastPos.current = pos;
    onMaskChange?.();
  }, [getCanvasPos, drawStroke, onMaskChange]);

  const handlePointerUp = useCallback(() => {
    if (!isDrawing.current) return;
    isDrawing.current = false;
    lastPos.current = null;
    saveToHistory();
    onMaskChange?.();
  }, [saveToHistory, onMaskChange]);

  const clearMask = useCallback(() => {
    const mask = maskCanvasRef.current;
    if (!mask) return;
    const ctx = mask.getContext('2d');
    ctx.clearRect(0, 0, mask.width, mask.height);
    saveToHistory();
    onMaskChange?.();
  }, [maskCanvasRef, saveToHistory, onMaskChange]);

  return {
    interactiveCanvasRef,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    undo,
    redo,
    canUndo,
    canRedo,
    clearMask,
    initHistory,
  };
}
