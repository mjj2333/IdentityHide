import { useRef, useEffect, useState, useCallback } from 'react';
import { usePipeline } from '../context/PipelineContext';
import { useImagePipeline } from '../hooks/useImagePipeline';

const HANDLE_SIZE = 8; // px in image coords, scaled when drawing
const EDGE_MARGIN = 10; // px threshold for edge detection

export default function ReviewScreen() {
  const {
    detections,
    detectionToggles,
    setDetectionToggles,
    blurSettings,
    setBlurSettings,
    outputCanvasRef,
    tattooMaskCanvasRef,
    metadata,
    setScreen,
    reset,
  } = usePipeline();

  const { recomposite } = useImagePipeline();
  const previewRef = useRef(null);
  const [renderCount, setRenderCount] = useState(0);
  const [hoveredDet, setHoveredDet] = useState(null); // index
  const dragRef = useRef(null); // { index, type: 'move'|'resize', edge, startMouse, startBox }

  // Convert mouse event on canvas element to image coordinates
  const canvasToImage = useCallback((e) => {
    const canvas = previewRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, []);

  // Hit test: which detection and what part (move, or resize edge)
  const hitTest = useCallback((imgPt) => {
    if (!imgPt) return null;
    const output = outputCanvasRef.current;
    if (!output) return null;
    const margin = EDGE_MARGIN * Math.max(1, output.width / 800);

    for (let i = detections.length - 1; i >= 0; i--) {
      if (detectionToggles[i] === false) continue;
      const det = detections[i];
      const x1 = det.topLeft[0], y1 = det.topLeft[1];
      const x2 = det.bottomRight[0], y2 = det.bottomRight[1];

      // Check if inside box (with margin outside for edge grabs)
      if (imgPt.x >= x1 - margin && imgPt.x <= x2 + margin &&
          imgPt.y >= y1 - margin && imgPt.y <= y2 + margin) {
        // Determine if near an edge
        const nearLeft = Math.abs(imgPt.x - x1) < margin;
        const nearRight = Math.abs(imgPt.x - x2) < margin;
        const nearTop = Math.abs(imgPt.y - y1) < margin;
        const nearBottom = Math.abs(imgPt.y - y2) < margin;

        if (nearLeft || nearRight || nearTop || nearBottom) {
          return {
            index: i,
            type: 'resize',
            edge: {
              left: nearLeft, right: nearRight,
              top: nearTop, bottom: nearBottom,
            },
          };
        }

        // Inside box = move
        if (imgPt.x >= x1 && imgPt.x <= x2 && imgPt.y >= y1 && imgPt.y <= y2) {
          return { index: i, type: 'move' };
        }
      }
    }
    return null;
  }, [detections, detectionToggles, outputCanvasRef]);

  // Get CSS cursor for a hit result
  const getCursor = useCallback((hit) => {
    if (!hit) return 'default';
    if (hit.type === 'move') return 'move';
    const { left, right, top, bottom } = hit.edge;
    if ((top && left) || (bottom && right)) return 'nwse-resize';
    if ((top && right) || (bottom && left)) return 'nesw-resize';
    if (top || bottom) return 'ns-resize';
    if (left || right) return 'ew-resize';
    return 'move';
  }, []);

  // Draw output canvas to preview
  const drawPreview = useCallback(() => {
    const preview = previewRef.current;
    const output = outputCanvasRef.current;
    if (!preview || !output) return;

    preview.width = output.width;
    preview.height = output.height;
    const ctx = preview.getContext('2d');
    ctx.drawImage(output, 0, 0);

    // Draw detection outlines
    let faceNum = 0, tattooNum = 0;
    detections.forEach((det, i) => {
      const isTattoo = det.type === 'tattoo';
      if (isTattoo) tattooNum++; else faceNum++;
      if (detectionToggles[i] === false) return;

      const x = det.topLeft[0];
      const y = det.topLeft[1];
      const w = det.bottomRight[0] - x;
      const h = det.bottomRight[1] - y;

      const isHovered = hoveredDet === i || (dragRef.current && dragRef.current.index === i);
      const lineW = Math.max(1, Math.round(output.width / 500));

      // Box outline
      ctx.strokeStyle = isTattoo
        ? 'rgba(255, 170, 0, 0.6)'
        : isHovered ? 'rgba(255, 255, 255, 0.9)' : 'rgba(255, 255, 255, 0.5)';
      ctx.lineWidth = isHovered ? lineW * 2 : lineW;
      ctx.setLineDash(isHovered ? [] : [6, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);

      // Label
      ctx.fillStyle = isTattoo ? 'rgba(255, 170, 0, 0.8)' : 'rgba(255, 255, 255, 0.7)';
      ctx.font = `${Math.max(12, Math.round(output.width / 60))}px system-ui`;
      const label = isTattoo ? `Tattoo ${tattooNum}` : `Face ${faceNum}`;
      ctx.fillText(label, x + 4, y - 6);

      // Draw resize handles when hovered/dragging
      if (isHovered) {
        const hs = Math.max(4, Math.round(output.width / 200)); // handle half-size
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        const corners = [
          [x, y], [x + w, y], [x, y + h], [x + w, y + h], // corners
          [x + w / 2, y], [x + w / 2, y + h], // top/bottom midpoints
          [x, y + h / 2], [x + w, y + h / 2], // left/right midpoints
        ];
        for (const [cx, cy] of corners) {
          ctx.fillRect(cx - hs, cy - hs, hs * 2, hs * 2);
        }
      }
    });
  }, [detections, detectionToggles, outputCanvasRef, hoveredDet]);

  useEffect(() => {
    drawPreview();
  }, [drawPreview, renderCount]);

  // Mouse handlers for drag interaction
  const handleMouseDown = useCallback((e) => {
    const imgPt = canvasToImage(e);
    const hit = hitTest(imgPt);
    if (!hit) return;

    e.preventDefault();
    const det = detections[hit.index];
    dragRef.current = {
      index: hit.index,
      type: hit.type,
      edge: hit.edge || null,
      startMouse: imgPt,
      startBox: {
        topLeft: [...det.topLeft],
        bottomRight: [...det.bottomRight],
      },
    };
  }, [canvasToImage, hitTest, detections]);

  const handleMouseMove = useCallback((e) => {
    const imgPt = canvasToImage(e);
    if (!imgPt) return;

    if (dragRef.current) {
      // Dragging — update detection bounds
      const { index, type, edge, startMouse, startBox } = dragRef.current;
      const dx = imgPt.x - startMouse.x;
      const dy = imgPt.y - startMouse.y;
      const det = detections[index];
      const output = outputCanvasRef.current;
      const maxW = output ? output.width : 9999;
      const maxH = output ? output.height : 9999;

      if (type === 'move') {
        const bw = startBox.bottomRight[0] - startBox.topLeft[0];
        const bh = startBox.bottomRight[1] - startBox.topLeft[1];
        let nx = startBox.topLeft[0] + dx;
        let ny = startBox.topLeft[1] + dy;
        // Clamp to canvas bounds
        nx = Math.max(0, Math.min(maxW - bw, nx));
        ny = Math.max(0, Math.min(maxH - bh, ny));
        det.topLeft = [nx, ny];
        det.bottomRight = [nx + bw, ny + bh];
      } else if (type === 'resize') {
        const minSize = 20;
        if (edge.left) det.topLeft[0] = Math.min(startBox.bottomRight[0] - minSize, Math.max(0, startBox.topLeft[0] + dx));
        if (edge.right) det.bottomRight[0] = Math.max(startBox.topLeft[0] + minSize, Math.min(maxW, startBox.bottomRight[0] + dx));
        if (edge.top) det.topLeft[1] = Math.min(startBox.bottomRight[1] - minSize, Math.max(0, startBox.topLeft[1] + dy));
        if (edge.bottom) det.bottomRight[1] = Math.max(startBox.topLeft[1] + minSize, Math.min(maxH, startBox.bottomRight[1] + dy));
      }

      drawPreview();
      return;
    }

    // Not dragging — update hover state and cursor
    const hit = hitTest(imgPt);
    const newHovered = hit ? hit.index : null;
    if (newHovered !== hoveredDet) setHoveredDet(newHovered);

    const canvas = previewRef.current;
    if (canvas) canvas.style.cursor = getCursor(hit);
  }, [canvasToImage, hitTest, detections, outputCanvasRef, hoveredDet, drawPreview, getCursor]);

  const handleMouseUp = useCallback(async () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    // Re-composite with updated detection positions
    await recomposite(detections, detectionToggles, blurSettings);
    setRenderCount(n => n + 1);
  }, [detections, detectionToggles, blurSettings, recomposite]);

  const handleMouseLeave = useCallback(() => {
    if (dragRef.current) {
      // Finish drag if mouse leaves canvas
      dragRef.current = null;
      recomposite(detections, detectionToggles, blurSettings).then(() => {
        setRenderCount(n => n + 1);
      });
    }
    setHoveredDet(null);
  }, [detections, detectionToggles, blurSettings, recomposite]);

  const toggleDetection = useCallback(async (index) => {
    const newToggles = [...detectionToggles];
    newToggles[index] = !newToggles[index];
    setDetectionToggles(newToggles);
    await recomposite(detections, newToggles, blurSettings);
    setRenderCount(n => n + 1);
  }, [detections, detectionToggles, setDetectionToggles, blurSettings, recomposite]);

  const handleModeChange = useCallback(async (mode) => {
    const newSettings = { ...blurSettings, mode };
    setBlurSettings(newSettings);
    await recomposite(detections, detectionToggles, newSettings);
    setRenderCount(n => n + 1);
  }, [detections, detectionToggles, blurSettings, setBlurSettings, recomposite]);

  const handleStrengthChange = useCallback(async (e) => {
    const strength = parseInt(e.target.value);
    const newSettings = { ...blurSettings, strength };
    setBlurSettings(newSettings);
    await recomposite(detections, detectionToggles, newSettings);
    setRenderCount(n => n + 1);
  }, [detections, detectionToggles, blurSettings, setBlurSettings, recomposite]);

  return (
    <div className="review-screen">
      <div className="review-header">
        <h2>Review & Adjust</h2>
        <p className="review-subtitle">
          {(() => {
            const faces = detections.filter(d => d.type !== 'tattoo');
            const tattoos = detections.filter(d => d.type === 'tattoo');
            const parts = [];
            if (faces.length > 0) parts.push(`${faces.length} face${faces.length > 1 ? 's' : ''}`);
            if (tattoos.length > 0) parts.push(`${tattoos.length} tattoo region${tattoos.length > 1 ? 's' : ''}`);
            return parts.length > 0
              ? `${parts.join(', ')} detected — drag boxes to reposition, drag edges to resize`
              : 'No faces or tattoos detected — use manual tools to mark regions';
          })()}
        </p>
      </div>

      <div className="review-layout">
        <div className="review-canvas-wrap">
          <canvas
            ref={previewRef}
            className="review-canvas"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
          />
        </div>

        <div className="review-sidebar">
          {metadata && (
            <div className="review-panel metadata-panel">
              <h3>Metadata Stripped</h3>
              <div className="metadata-badge">EXIF Removed</div>
              {metadata.camera && <p><span className="meta-label">Camera:</span> {metadata.camera}</p>}
              {metadata.dateTime && <p><span className="meta-label">Date:</span> {metadata.dateTime}</p>}
              {metadata.gps && (
                <p className="meta-gps">
                  <span className="meta-label">GPS:</span> {metadata.gps.lat}, {metadata.gps.lng}
                  <span className="meta-removed"> (removed)</span>
                </p>
              )}
              {metadata.software && <p><span className="meta-label">Software:</span> {metadata.software}</p>}
              {!metadata.camera && !metadata.gps && !metadata.dateTime && (
                <p className="meta-none">No sensitive metadata found</p>
              )}
            </div>
          )}

          <div className="review-panel detections-panel">
            <h3>Detections</h3>
            {detections.length === 0 && (
              <p className="no-detections">No faces or tattoos found. You can manually mark regions in the editor.</p>
            )}
            {detections.map((det, i) => {
              const isTattoo = det.type === 'tattoo';
              const faceIndex = isTattoo ? null : detections.slice(0, i).filter(d => d.type !== 'tattoo').length + 1;
              const tattooIndex = isTattoo ? detections.slice(0, i).filter(d => d.type === 'tattoo').length + 1 : null;
              return (
                <label key={i} className={`detection-item ${isTattoo ? 'detection-tattoo' : ''} ${hoveredDet === i ? 'detection-hovered' : ''}`}>
                  <input
                    type="checkbox"
                    checked={detectionToggles[i] !== false}
                    onChange={() => toggleDetection(i)}
                  />
                  <span>{isTattoo ? `Tattoo ${tattooIndex}` : `Face ${faceIndex}`}</span>
                  <span className="detection-confidence">
                    {Math.round(det.probability * 100)}%
                  </span>
                </label>
              );
            })}
          </div>

          <div className="review-panel blur-panel">
            <h3>Blur Settings</h3>
            <div className="blur-modes">
              {['gaussian', 'pixelate', 'blackbar'].map((mode) => (
                <button
                  key={mode}
                  className={`blur-mode-btn ${blurSettings.mode === mode ? 'active' : ''}`}
                  onClick={() => handleModeChange(mode)}
                >
                  {mode === 'gaussian' ? 'Blur' : mode === 'pixelate' ? 'Pixelate' : 'Black Bar'}
                </button>
              ))}
            </div>
            <label className="strength-slider">
              <span>{blurSettings.mode === 'blackbar' ? `Bar Height: ${blurSettings.strength}` : `Strength: ${blurSettings.strength}`}</span>
              <input
                type="range"
                min="5"
                max="60"
                value={blurSettings.strength}
                onChange={handleStrengthChange}
              />
            </label>
          </div>

          <div className="review-actions">
            <button className="btn btn-primary" onClick={() => setScreen('export')}>
              Approve & Export
            </button>
            <button className="btn btn-ghost" onClick={() => {
              if (window.confirm('Start over with a different image? All progress will be lost.')) reset();
            }}>
              Start Over
            </button>
            <button className="btn btn-secondary" onClick={() => {
              // Clear mask for next pass
              if (tattooMaskCanvasRef.current) {
                const ctx = tattooMaskCanvasRef.current.getContext('2d');
                ctx.clearRect(0, 0, tattooMaskCanvasRef.current.width, tattooMaskCanvasRef.current.height);
              }
              setScreen('mask-edit');
            }}>
              Edit Tattoo Masks
            </button>
            <button className="btn btn-secondary" onClick={() => setScreen('editor')}>
              Refine Manually
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
