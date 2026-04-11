/**
 * Hook for pinch-to-zoom and pan on canvases.
 * Computes a fitScale so the image always fits the container at scale=1.
 * Supports touch pinch, scroll wheel, and double-tap to reset.
 */
import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';

const MIN_SCALE = 0.5;
const MAX_SCALE = 10;
const WHEEL_ZOOM_IN = 1.1;
const WHEEL_ZOOM_OUT = 0.9;
const DOUBLE_TAP_TIMEOUT = 300;
const TOUCH_SETTLE_DELAY = 50;

export function useZoomPan(imageWidth, imageHeight, containerRef, { oneFingerPan = false } = {}) {
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [fitScale, setFitScale] = useState(null);

  const scaleRef = useRef(1);
  scaleRef.current = scale;
  const fitScaleRef = useRef(null);

  const isPanning = useRef(false);
  const lastPinchDist = useRef(0);
  const lastPinchMid = useRef({ x: 0, y: 0 });
  const lastPanPos = useRef({ x: 0, y: 0 });
  const doubleTapTime = useRef(0);

  // Compute fitScale: the CSS scale that makes the image exactly fit the container.
  // Uses useLayoutEffect to avoid a flash of the full-size canvas before paint.
  useLayoutEffect(() => {
    const el = containerRef?.current;
    if (!el || imageWidth < 2 || imageHeight < 2) return;

    const compute = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const fs = Math.min(rect.width / imageWidth, rect.height / imageHeight);
      setFitScale(fs);
      fitScaleRef.current = fs;
      // Re-clamp translate for new dimensions
      setTranslate(prev => {
        const combined = fs * scaleRef.current;
        const visW = imageWidth * combined;
        const visH = imageHeight * combined;
        if (visW <= rect.width && visH <= rect.height) return { x: 0, y: 0 };
        const maxTx = Math.max(0, (visW - rect.width) / 2);
        const maxTy = Math.max(0, (visH - rect.height) / 2);
        return {
          x: Math.max(-maxTx, Math.min(maxTx, prev.x)),
          y: Math.max(-maxTy, Math.min(maxTy, prev.y)),
        };
      });
    };

    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef, imageWidth, imageHeight]);

  const clampTranslate = useCallback((tx, ty, s, containerEl) => {
    const fs = fitScaleRef.current || 1;
    const combined = fs * s;
    if (!containerEl) return { x: tx, y: ty };
    const rect = containerEl.getBoundingClientRect();
    const visW = imageWidth * combined;
    const visH = imageHeight * combined;
    if (visW <= rect.width && visH <= rect.height) return { x: 0, y: 0 };
    const maxTx = Math.max(0, (visW - rect.width) / 2);
    const maxTy = Math.max(0, (visH - rect.height) / 2);
    return {
      x: Math.max(-maxTx, Math.min(maxTx, tx)),
      y: Math.max(-maxTy, Math.min(maxTy, ty)),
    };
  }, [imageWidth, imageHeight]);

  const resetZoom = useCallback(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
    isPanning.current = false;
  }, []);

  // --- Scroll wheel: zoom when at fit or Ctrl held, pan when zoomed in ---
  const handleWheel = useCallback((e) => {
    e.preventDefault();

    if (e.ctrlKey || scaleRef.current <= 1) {
      const delta = e.deltaY > 0 ? WHEEL_ZOOM_OUT : WHEEL_ZOOM_IN;
      setScale(prev => {
        const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev * delta));
        if (next <= 1) setTranslate({ x: 0, y: 0 });
        return next;
      });
    } else {
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
      isPanning.current = true;
      lastPinchDist.current = getTouchDist(e.touches[0], e.touches[1]);
      lastPinchMid.current = getTouchMid(e.touches[0], e.touches[1]);
      e.preventDefault();
    } else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - doubleTapTime.current < DOUBLE_TAP_TIMEOUT) {
        resetZoom();
        e.preventDefault();
      }
      doubleTapTime.current = now;

      if (scaleRef.current > 1) {
        lastPanPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        if (oneFingerPan) {
          isPanning.current = true;
        }
      }
    }
  }, [resetZoom, oneFingerPan]);

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

        const dx = mid.x - lastPinchMid.current.x;
        const dy = mid.y - lastPinchMid.current.y;
        setTranslate(prev => {
          const container = e.currentTarget;
          return clampTranslate(prev.x + dx, prev.y + dy, scaleRef.current, container);
        });
      }

      lastPinchDist.current = dist;
      lastPinchMid.current = mid;
    } else if (e.touches.length === 1 && oneFingerPan && isPanning.current) {
      e.preventDefault();
      const dx = e.touches[0].clientX - lastPanPos.current.x;
      const dy = e.touches[0].clientY - lastPanPos.current.y;
      lastPanPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      setTranslate(prev => {
        const container = e.currentTarget;
        return clampTranslate(prev.x + dx, prev.y + dy, scaleRef.current, container);
      });
    }
  }, [scale, clampTranslate, oneFingerPan]);

  const handleTouchEnd = useCallback((e) => {
    if (e.touches.length < 2) {
      lastPinchDist.current = 0;
      setTimeout(() => { isPanning.current = false; }, TOUCH_SETTLE_DELAY);
    }
  }, []);

  // --- Transform CSS — includes fitScale so the image fits the container ---
  const getTransformStyle = useCallback(() => {
    // Before fitScale is measured, use 0 to hide canvas (avoids full-size flash)
    const fs = fitScale != null ? fitScale : 0;
    return `translate(${translate.x}px, ${translate.y}px) scale(${fs * scale})`;
  }, [scale, translate, fitScale]);

  // --- Coordinate mapping: screen -> image space, accounting for zoom ---
  const screenToImage = useCallback((clientX, clientY, canvasEl) => {
    if (!canvasEl) return { x: 0, y: 0 };
    const rect = canvasEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };

    const scaleX = imageWidth / rect.width;
    const scaleY = imageHeight / rect.height;

    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }, [imageWidth, imageHeight]);

  return {
    scale,
    fitScale,
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
