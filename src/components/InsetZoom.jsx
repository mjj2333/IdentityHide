import { useRef, useEffect } from 'react';

const SIZE = 150;
const ZOOM = 3;
const HALF = SIZE / 2;

export default function InsetZoom({ displayCanvasRef, cursorPos, imageWidth, imageHeight, screenToImage }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    if (!cursorPos || !displayCanvasRef?.current) return;

    const draw = () => {
      rafRef.current = null;
      const canvas = canvasRef.current;
      const source = displayCanvasRef.current;
      if (!canvas || !source) return;

      const ctx = canvas.getContext('2d');
      const pt = screenToImage(cursorPos.x, cursorPos.y, source);

      // Source region in image space
      const srcSize = SIZE / ZOOM;
      const sx = pt.x - srcSize / 2;
      const sy = pt.y - srcSize / 2;

      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(source, sx, sy, srcSize, srcSize, 0, 0, SIZE, SIZE);

      // Crosshair
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(HALF, HALF - 10);
      ctx.lineTo(HALF, HALF + 10);
      ctx.moveTo(HALF - 10, HALF);
      ctx.lineTo(HALF + 10, HALF);
      ctx.stroke();
    };

    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(draw);
    }

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [cursorPos, displayCanvasRef, screenToImage, imageWidth, imageHeight]);

  if (!cursorPos) return null;

  return (
    <canvas
      ref={canvasRef}
      className="inset-zoom"
      width={SIZE}
      height={SIZE}
      aria-hidden="true"
    />
  );
}
