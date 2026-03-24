import { useRef, useEffect, useCallback, useState } from 'react';
import { usePipeline } from '../context/PipelineContext';
import { useCanvas } from '../hooks/useCanvas';
import { applyMaskedBlur } from '../utils/blurEngine';

export default function EditorScreen() {
  const {
    strippedCanvasRef,
    maskCanvasRef,
    outputCanvasRef,
    blurSettings,
    setBlurSettings,
    brushSettings,
    setBrushSettings,
    setScreen,
  } = usePipeline();

  const displayRef = useRef(null);
  const [, forceRender] = useState(0);
  const blurSettingsRef = useRef(blurSettings);
  blurSettingsRef.current = blurSettings;

  // Recomposite when mask changes — use ref to avoid stale closure
  const onMaskChange = useCallback(() => {
    if (!strippedCanvasRef.current || !maskCanvasRef.current) return;
    const output = applyMaskedBlur(
      strippedCanvasRef.current,
      maskCanvasRef.current,
      blurSettingsRef.current.mode,
      blurSettingsRef.current.strength
    );
    outputCanvasRef.current = output;
    forceRender(n => n + 1);
  }, [strippedCanvasRef, maskCanvasRef, outputCanvasRef]);

  const {
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    undo,
    redo,
    canUndo,
    canRedo,
    clearMask,
    initHistory,
  } = useCanvas(maskCanvasRef, onMaskChange);

  // Initialize
  useEffect(() => {
    initHistory();
    onMaskChange();
  }, []);

  // Draw display canvas
  useEffect(() => {
    const display = displayRef.current;
    const output = outputCanvasRef.current;
    if (!display || !output) return;

    display.width = output.width;
    display.height = output.height;
    const ctx = display.getContext('2d');
    ctx.drawImage(output, 0, 0);

    // Draw subtle dashed outline around masked regions so user can see where blur is applied
    const mask = maskCanvasRef.current;
    if (mask) {
      const maskCtx = mask.getContext('2d');
      const maskData = maskCtx.getImageData(0, 0, mask.width, mask.height);
      // Find bounding box of non-transparent mask pixels to draw outline
      let minX = mask.width, minY = mask.height, maxX = 0, maxY = 0;
      let hasMask = false;
      const step = 4; // sample every 4th pixel for performance
      for (let y = 0; y < mask.height; y += step) {
        for (let x = 0; x < mask.width; x += step) {
          if (maskData.data[(y * mask.width + x) * 4 + 3] > 128) {
            hasMask = true;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (hasMask) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = Math.max(1, Math.round(output.width / 500));
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(minX - 4, minY - 4, maxX - minX + 8, maxY - minY + 8);
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
  });

  // Pointer event handlers — using display canvas directly
  const onDown = useCallback((e) => {
    e.preventDefault();
    handlePointerDown(e, brushSettings.tool, brushSettings.size);
  }, [handlePointerDown, brushSettings]);

  const onMove = useCallback((e) => {
    e.preventDefault();
    handlePointerMove(e, brushSettings.tool, brushSettings.size);
  }, [handlePointerMove, brushSettings]);

  const onUp = useCallback((e) => {
    e.preventDefault();
    handlePointerUp();
  }, [handlePointerUp]);

  const handleModeChange = useCallback((mode) => {
    blurSettingsRef.current = { ...blurSettingsRef.current, mode };
    setBlurSettings(blurSettingsRef.current);
    onMaskChange();
  }, [setBlurSettings, onMaskChange]);

  const handleStrengthChange = useCallback((e) => {
    const strength = parseInt(e.target.value);
    blurSettingsRef.current = { ...blurSettingsRef.current, strength };
    setBlurSettings(blurSettingsRef.current);
    onMaskChange();
  }, [setBlurSettings, onMaskChange]);

  return (
    <div className="editor-screen">
      <div className="editor-toolbar">
        <div className="toolbar-group">
          <button
            className={`tool-btn ${brushSettings.tool === 'brush' ? 'active' : ''}`}
            onClick={() => setBrushSettings(s => ({ ...s, tool: 'brush' }))}
            title="Brush — paint areas to blur"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 19l7-7 3 3-7 7-3-3z" />
              <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
            </svg>
            Brush
          </button>
          <button
            className={`tool-btn ${brushSettings.tool === 'eraser' ? 'active' : ''}`}
            onClick={() => setBrushSettings(s => ({ ...s, tool: 'eraser' }))}
            title="Eraser — reveal original image"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 20H7L3 16l9-9 8 8-4 4" />
              <path d="M6 11l4-4" />
            </svg>
            Eraser
          </button>
        </div>

        <div className="toolbar-group">
          <label className="toolbar-slider">
            <span>Size: {brushSettings.size}</span>
            <input
              type="range"
              min="5"
              max="150"
              value={brushSettings.size}
              onChange={(e) => setBrushSettings(s => ({ ...s, size: parseInt(e.target.value) }))}
            />
          </label>
        </div>

        <div className="toolbar-group">
          {['gaussian', 'pixelate', 'blackbar'].map((mode) => (
            <button
              key={mode}
              className={`blur-mode-btn ${blurSettings.mode === mode ? 'active' : ''}`}
              onClick={() => handleModeChange(mode)}
            >
              {mode === 'gaussian' ? 'Blur' : mode === 'pixelate' ? 'Pixelate' : 'Black'}
            </button>
          ))}
          <label className="toolbar-slider">
            <span>Strength: {blurSettings.strength}</span>
            <input
              type="range"
              min="5"
              max="60"
              value={blurSettings.strength}
              onChange={handleStrengthChange}
            />
          </label>
        </div>

        <div className="toolbar-group">
          <button className="tool-btn" onClick={undo} disabled={!canUndo} title="Undo">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </button>
          <button className="tool-btn" onClick={redo} disabled={!canRedo} title="Redo">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" />
            </svg>
          </button>
          <button className="tool-btn" onClick={clearMask} title="Clear all masks">
            Clear
          </button>
        </div>
      </div>

      <div className="editor-canvas-container">
        <canvas
          ref={displayRef}
          className="editor-display-canvas"
          style={{ cursor: 'crosshair', touchAction: 'none' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onUp}
        />
      </div>

      <div className="editor-footer">
        <button className="btn btn-secondary" onClick={() => setScreen('review')}>
          Back to Review
        </button>
        <button className="btn btn-primary" onClick={() => setScreen('export')}>
          Done &mdash; Export
        </button>
      </div>
    </div>
  );
}
