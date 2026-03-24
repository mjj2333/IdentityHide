/**
 * Hook for pinch-to-zoom and pan on the mask editor canvas.
 * Supports touch pinch, scroll wheel, and double-tap to reset.
 */
import { useState, useRef, useCallback, useEffect } from 'react';

const MIN_SCALE = 1;
const MAX_SCALE = 5;

export function useZoomPan(imageWidth, imageHeight, containerRef) {
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });

  const scaleRef = useRef(1);
  scaleRef.current = scale;

  const isPanning = useRef(false);
  const lastPinchDist = useRef(0);
  const lastPinchMid = useRef({ x: 0, y: 0 });
  const lastPanPos = useRef({ x: 0, y: 0 });
  const doubleTapTime = useRef(0);

  const clampTranslate = useCallback((tx, ty, s, containerEl) => {
    if (s <= 1) return { x: 0, y: 0 };
    if (!containerEl) return { x: tx, y: ty };
    const rect = containerEl.getBoundingClientRect();
    const maxTx = (rect.width * (s - 1)) / 2;
    const maxTy = (rect.height * (s - 1)) / 2;
    return {
      x: Math.max(-maxTx, Math.min(maxTx, tx)),
      y: Math.max(-maxTy, Math.min(maxTy, ty)),
    };
  }, []);

  const resetZoom = useCallback(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
    isPanning.current = false;
  }, []);

  // --- Scroll wheel: zoom when at 1x or Ctrl held, pan when zoomed ---
  const handleWheel = useCallback((e) => {
    e.preventDefault();

    if (e.ctrlKey || scaleRef.current <= 1) {
      // Zoom in/out
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setScale(prev => {
        const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev * delta));
        if (next <= 1) setTranslate({ x: 0, y: 0 });
        return next;
      });
    } else {
      // Pan when zoomed — deltaY for vertical, deltaX for horizontal
      setTranslate(prev => {
        const container = containerRef?.current;
        return clampTranslate(
          prev.x - e.deltaX,
          prev.y - e.deltaY,
          scaleRef.current,
          container
        );
      });
    }
  }, [clampTranslate, containerRef]);

  // Attach wheel listener natively with { passive: false } to allow preventDefault
  useEffect(() => {
    const el = containerRef?.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [containerRef, handleWheel]);

  // --- Touch gestures ---
  const getTouchDist = (t1, t2) => {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const getTouchMid = (t1, t2) => ({
    x: (t1.clientX + t2.clientX) / 2,
    y: (t1.clientY + t2.clientY) / 2,
  });

  const handleTouchStart = useCallback((e) => {
    if (e.touches.length === 2) {
      // Begin pinch
      isPanning.current = true;
      lastPinchDist.current = getTouchDist(e.touches[0], e.touches[1]);
      lastPinchMid.current = getTouchMid(e.touches[0], e.touches[1]);
      e.preventDefault();
    } else if (e.touches.length === 1) {
      // Double-tap detection
      const now = Date.now();
      if (now - doubleTapTime.current < 300) {
        resetZoom();
        e.preventDefault();
      }
      doubleTapTime.current = now;

      // Pan when zoomed
      if (scale > 1) {
        lastPanPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    }
  }, [scale, resetZoom]);

  const handleTouchMove = useCallback((e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const dist = getTouchDist(e.touches[0], e.touches[1]);
      const mid = getTouchMid(e.touches[0], e.touches[1]);

      if (lastPinchDist.current > 0) {
        const ratio = dist / lastPinchDist.current;
        setScale(prev => {
          const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev * ratio));
          if (next <= 1) {
            setTranslate({ x: 0, y: 0 });
          }
          return next;
        });

        // Pan to keep midpoint stationary
        const dx = mid.x - lastPinchMid.current.x;
        const dy = mid.y - lastPinchMid.current.y;
        setTranslate(prev => {
          const container = e.currentTarget;
          return clampTranslate(prev.x + dx, prev.y + dy, scale, container);
        });
      }

      lastPinchDist.current = dist;
      lastPinchMid.current = mid;
    }
  }, [scale, clampTranslate]);

  const handleTouchEnd = useCallback((e) => {
    if (e.touches.length < 2) {
      lastPinchDist.current = 0;
      // Small delay before allowing paint again
      setTimeout(() => { isPanning.current = false; }, 50);
    }
  }, []);

  // --- Transform CSS ---
  const getTransformStyle = useCallback(() => {
    return `translate(${translate.x}px, ${translate.y}px) scale(${scale})`;
  }, [scale, translate]);

  // --- Coordinate mapping: screen -> image space, accounting for zoom ---
  const screenToImage = useCallback((clientX, clientY, canvasEl) => {
    if (!canvasEl) return { x: 0, y: 0 };
    const rect = canvasEl.getBoundingClientRect();

    // The canvas element is CSS-scaled by object-fit:contain inside the zoom wrapper.
    // rect already reflects the zoomed/translated bounding box.
    const scaleX = imageWidth / rect.width;
    const scaleY = imageHeight / rect.height;

    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }, [imageWidth, imageHeight]);

  return {
    scale,
    isPanning,
    translate,
    getTransformStyle,
    screenToImage,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    resetZoom,
  };
}
