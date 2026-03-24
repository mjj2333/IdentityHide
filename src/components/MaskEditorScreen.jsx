import { useRef, useEffect, useCallback, useState } from 'react';
import { usePipeline } from '../context/PipelineContext';
import { useMaskEditor } from '../hooks/useMaskEditor';
import { useImagePipeline } from '../hooks/useImagePipeline';
import { useTattooSegModel } from '../hooks/useTattooSegModel';
import { useZoomPan } from '../hooks/useZoomPan';
import { saveTrainingPair } from '../utils/trainingDataStore';
import PairImportModal from './PairImportModal';

function loadFileToCanvas(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
    img.src = url;
  });
}

/** Load a white-on-black mask file and convert RGB brightness → alpha channel. */
function loadMaskToCanvas(file, w, h) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const id = ctx.getImageData(0, 0, w, h);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const bright = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        const on = bright > 128 ? 255 : 0;
        d[i] = on; d[i + 1] = on; d[i + 2] = on; d[i + 3] = on;
      }
      ctx.putImageData(id, 0, 0);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load mask')); };
    img.src = url;
  });
}

export default function MaskEditorScreen() {
  const {
    strippedCanvasRef,
    tattooMaskCanvasRef,
    exclusionMaskCanvasRef,
    samScaleRef,
    detections,
    setScreen,
  } = usePipeline();

  const { recompositeWithCustomMask } = useImagePipeline();
  const {
    selectedSubject, setSelectedSubject, subjects, addSubject,
    modelReady, isTraining, trainingProgress, pairCount,
    trainModel, predict, deleteModel, clearTrainingData, refreshPairCount,
  } = useTattooSegModel();

  const displayRef = useRef(null);
  const canvasContainerRef = useRef(null);
  const [applying, setApplying] = useState(false);
  const [applyStatus, setApplyStatus] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [cursorPos, setCursorPos] = useState(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [renderKey, setRenderKey] = useState(0);
  const [expansion, setExpansion] = useState(8);
  const [feather, setFeather] = useState(8);
  const [showBWMask, setShowBWMask] = useState(false);
  const [faceBlurEnabled, setFaceBlurEnabled] = useState(true);

  const MASK_COLORS = [
    { name: 'Red',    rgb: [255, 80, 80] },
    { name: 'Green',  rgb: [80, 220, 80] },
    { name: 'Blue',   rgb: [80, 120, 255] },
    { name: 'Cyan',   rgb: [80, 230, 230] },
    { name: 'Yellow', rgb: [240, 230, 60] },
    { name: 'White',  rgb: [255, 255, 255] },
  ];
  const [maskColorIdx, setMaskColorIdx] = useState(0);
  const maskColor = MASK_COLORS[maskColorIdx].rgb;
  const forceRender = useCallback(() => setRenderKey(k => k + 1), []);

  const imgW = strippedCanvasRef.current?.width || 1;
  const imgH = strippedCanvasRef.current?.height || 1;

  const {
    scale, isPanning, getTransformStyle, screenToImage,
    handleTouchStart, handleTouchMove, handleTouchEnd, resetZoom,
  } = useZoomPan(imgW, imgH, canvasContainerRef);

  const {
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
  } = useMaskEditor(tattooMaskCanvasRef, exclusionMaskCanvasRef, samScaleRef, imgW, imgH, detections, forceRender, screenToImage);

  // Initialize tattoo mask canvas + edge map
  useEffect(() => {
    if (!strippedCanvasRef.current) return;
    if (!tattooMaskCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = imgW;
      c.height = imgH;
      tattooMaskCanvasRef.current = c;
    }
    if (!exclusionMaskCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = imgW;
      c.height = imgH;
      exclusionMaskCanvasRef.current = c;
    }
    initHistory();
    initEdgeMap(strippedCanvasRef.current);
  }, []);

  // Render display: source image + mask overlay
  const renderDisplay = useCallback(() => {
    const display = displayRef.current;
    const src = strippedCanvasRef.current;
    const mask = tattooMaskCanvasRef.current;
    if (!display || !src) return;

    display.width = imgW;
    display.height = imgH;
    const ctx = display.getContext('2d');

    ctx.drawImage(src, 0, 0);

    // Draw tattoo bboxes as dashed outlines
    const tattoos = detections.filter(d => d.type === 'tattoo');
    if (tattoos.length > 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 170, 0, 0.5)';
      ctx.lineWidth = Math.max(1, Math.round(imgW / 400));
      ctx.setLineDash([8, 5]);
      tattoos.forEach(det => {
        const x = det.topLeft[0], y = det.topLeft[1];
        const w = det.bottomRight[0] - x, h = det.bottomRight[1] - y;
        ctx.strokeRect(x, y, w, h);
      });
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Draw mask overlay + expansion/feather zone preview
    if (mask) {
      const maskCtx = mask.getContext('2d');
      const maskData = maskCtx.getImageData(0, 0, imgW, imgH);
      const imgData = ctx.getImageData(0, 0, imgW, imgH);
      const d = imgData.data;
      const m = maskData.data;
      const [mr, mg, mb] = maskColor;

      // Compute blurred masks for expansion/feather preview (GPU-accelerated blur)
      let expAlphas = null, featAlphas = null;
      if (expansion > 0 || feather > 0) {
        const temp = document.createElement('canvas');
        temp.width = imgW; temp.height = imgH;
        temp.getContext('2d').drawImage(mask, 0, 0);

        if (expansion > 0) {
          const ec = document.createElement('canvas');
          ec.width = imgW; ec.height = imgH;
          const ectx = ec.getContext('2d');
          ectx.filter = `blur(${expansion}px)`;
          ectx.drawImage(temp, 0, 0);
          expAlphas = ectx.getImageData(0, 0, imgW, imgH).data;
        }

        const totalR = expansion + feather;
        if (totalR > 0) {
          const fc = document.createElement('canvas');
          fc.width = imgW; fc.height = imgH;
          const fctx = fc.getContext('2d');
          fctx.filter = `blur(${totalR}px)`;
          fctx.drawImage(temp, 0, 0);
          featAlphas = fctx.getImageData(0, 0, imgW, imgH).data;
        }
      }

      for (let idx = 0; idx < d.length; idx += 4) {
        if (showBWMask) {
          // B&W mode: white = masked, black = unmasked
          const v = m[idx + 3] > 0 ? 255 : 0;
          d[idx] = v; d[idx + 1] = v; d[idx + 2] = v;
        } else if (m[idx + 3] > 0) {
          // Original mask — colored overlay
          const t = (m[idx + 3] / 255) * 0.45;
          d[idx]     = Math.round(d[idx]     * (1 - t) + mr * t);
          d[idx + 1] = Math.round(d[idx + 1] * (1 - t) + mg * t);
          d[idx + 2] = Math.round(d[idx + 2] * (1 - t) + mb * t);
        } else {
          // Expansion zone — blue
          const expA = expAlphas ? expAlphas[idx + 3] / 255 : 0;
          if (expA > 0.15) {
            const t = Math.min(0.35, expA * 0.45);
            d[idx]     = Math.round(d[idx]     * (1 - t) + 30 * t);
            d[idx + 1] = Math.round(d[idx + 1] * (1 - t) + 140 * t);
            d[idx + 2] = Math.round(d[idx + 2] * (1 - t) + 255 * t);
          } else {
            // Feather zone — green, fading
            const featA = featAlphas ? featAlphas[idx + 3] / 255 : 0;
            if (featA > 0.03) {
              const t = featA * 0.25;
              d[idx]     = Math.round(d[idx]     * (1 - t) + 0 * t);
              d[idx + 1] = Math.round(d[idx + 1] * (1 - t) + 255 * t);
              d[idx + 2] = Math.round(d[idx + 2] * (1 - t) + 100 * t);
            }
          }
        }
      }
      // Exclusion mask overlay (orange)
      const exMask = exclusionMaskCanvasRef.current;
      if (exMask) {
        const exData = exMask.getContext('2d').getImageData(0, 0, imgW, imgH).data;
        for (let idx = 0; idx < d.length; idx += 4) {
          if (exData[idx + 3] > 0) {
            const t = (exData[idx + 3] / 255) * 0.4;
            d[idx]     = Math.round(d[idx]     * (1 - t) + 255 * t);
            d[idx + 1] = Math.round(d[idx + 1] * (1 - t) + 140 * t);
            d[idx + 2] = Math.round(d[idx + 2] * (1 - t) + 0 * t);
          }
        }
      }

      ctx.putImageData(imgData, 0, 0);
    }
  }, [imgW, imgH, strippedCanvasRef, tattooMaskCanvasRef, exclusionMaskCanvasRef, detections, maskColor, expansion, feather, showBWMask]);

  useEffect(() => {
    renderDisplay();
  });

  const onDown = useCallback((e) => {
    if (isPanning.current) return; // pinch/pan in progress
    e.preventDefault();
    handlePointerDown(e, displayRef.current);
    forceRender();

    // Track pointer globally so strokes continue past canvas edges
    const onGlobalMove = (ev) => {
      handlePointerMove(ev, displayRef.current);
      setCursorPos({ x: ev.clientX, y: ev.clientY });
      forceRender();
    };
    const onGlobalUp = () => {
      handlePointerUp();
      forceRender();
      window.removeEventListener('pointermove', onGlobalMove);
      window.removeEventListener('pointerup', onGlobalUp);
    };
    window.addEventListener('pointermove', onGlobalMove);
    window.addEventListener('pointerup', onGlobalUp);
  }, [isPanning, handlePointerDown, handlePointerMove, handlePointerUp, forceRender]);

  const handleInvertMask = useCallback(() => {
    const mask = tattooMaskCanvasRef.current;
    if (!mask) return;
    const ctx = mask.getContext('2d');
    const data = ctx.getImageData(0, 0, mask.width, mask.height);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i + 3] = d[i + 3] > 128 ? 0 : 255;
      if (d[i + 3] === 255) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; }
    }
    ctx.putImageData(data, 0, 0);
    forceRender();
  }, [tattooMaskCanvasRef, forceRender]);

  const handleApply = useCallback(async () => {
    setApplying(true);
    setApplyStatus('Preparing...');
    try {
      await recompositeWithCustomMask(tattooMaskCanvasRef.current, selectedSubject, {
        dilateRadius: expansion,
        featherRadius: feather,
        faceBlur: faceBlurEnabled,
        exclusionMask: exclusionMaskCanvasRef.current,
        onProgress: (msg) => setApplyStatus(msg),
      });
      setScreen('review');
    } catch (err) {
      console.error('Apply failed:', err);
      setApplying(false);
      setApplyStatus('');
    }
  }, [recompositeWithCustomMask, tattooMaskCanvasRef, setScreen, selectedSubject, expansion, feather, faceBlurEnabled]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
        e.preventDefault();
        undo();
        forceRender();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z') || (e.shiftKey && e.key === 'Z'))) {
        e.preventDefault();
        redo();
        forceRender();
      }
      if (e.key === 'Enter' || ((e.ctrlKey || e.metaKey) && e.key === 's')) {
        e.preventDefault();
        if (!applying) handleApply();
      }
      if (e.key === '[') setBrushSize(s => Math.max(5, s - 10));
      if (e.key === ']') setBrushSize(s => Math.min(200, s + 10));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo, forceRender, applying, handleApply, setBrushSize]);

  const handleSuggestMask = useCallback(async () => {
    if (!strippedCanvasRef.current || !modelReady) return;
    setSuggesting(true);
    try {
      const predicted = await predict(strippedCanvasRef.current);
      if (predicted && tattooMaskCanvasRef.current) {
        const ctx = tattooMaskCanvasRef.current.getContext('2d');
        ctx.clearRect(0, 0, imgW, imgH);
        ctx.drawImage(predicted, 0, 0);
        initHistory();
        forceRender();
      }
    } catch (err) {
      console.error('[MaskEditor] Suggest mask failed:', err);
    } finally {
      setSuggesting(false);
    }
  }, [strippedCanvasRef, tattooMaskCanvasRef, modelReady, predict, imgW, imgH, initHistory, forceRender]);

  const handleTrain = useCallback(async () => {
    try {
      await trainModel({ epochs: 30, batchSize: 2, learningRate: 0.001 });
      await refreshPairCount();
    } catch (err) {
      console.error('[MaskEditor] Training failed:', err);
    }
  }, [trainModel, refreshPairCount]);

  const handleDeleteModel = useCallback(async () => {
    if (!window.confirm(`Delete trained model for "${selectedSubject}"?`)) return;
    await deleteModel();
  }, [deleteModel, selectedSubject]);

  const handleClearTrainingData = useCallback(async () => {
    if (!window.confirm(`Delete all ${pairCount} training pairs for "${selectedSubject}"?`)) return;
    await clearTrainingData();
    console.log(`[MaskEditor] Cleared training data for "${selectedSubject}"`);
  }, [clearTrainingData, pairCount, selectedSubject]);

  const handleAddSubject = useCallback(() => {
    const name = window.prompt('Enter subject name (e.g. "taylor", "brooke"):');
    if (name) addSubject(name);
  }, [addSubject]);

  const handleImportPairs = useCallback(async (pairs) => {
    let imported = 0;
    for (const { imageFile, maskFile } of pairs) {
      try {
        const imgCanvas = await loadFileToCanvas(imageFile);
        const maskCanvas = await loadMaskToCanvas(maskFile, imgCanvas.width, imgCanvas.height);
        await saveTrainingPair(imgCanvas, maskCanvas, selectedSubject);
        imported++;
      } catch (err) {
        console.error(`[Import] Failed:`, err);
      }
    }
    await refreshPairCount();
    console.log(`[MaskEditor] Imported ${imported}/${pairs.length} pairs for "${selectedSubject}"`);
  }, [selectedSubject, refreshPairCount]);

  const handleSkip = useCallback(() => {
    setScreen('review');
  }, [setScreen]);

  return (
    <div className="mask-editor-screen">
      <div className="mask-editor-toolbar">
        {/* Row 1: Primary tools */}
        <div className="toolbar-row">
          <div className="toolbar-group">
            <button
              className={`tool-btn ${activeTool === 'brush' ? 'active' : ''}`}
              onClick={() => setActiveTool('brush')}
              title="Paint over tattoo areas"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 19l7-7 3 3-7 7-3-3z" />
                <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
              </svg>
              Brush
            </button>
            <button
              className={`tool-btn ${activeTool === 'eraser' ? 'active' : ''}`}
              onClick={() => setActiveTool('eraser')}
              title="Erase mask areas"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 20H7L3 16l9-9 8 8-4 4" />
                <path d="M6 11l4-4" />
              </svg>
              Eraser
            </button>
            <button
              className={`tool-btn ${edgeSnap ? 'active' : ''}`}
              onClick={() => setEdgeSnap(v => !v)}
              title="Edge-aware brush: stops painting at hard edges"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 4v16h16" />
                <path d="M4 12h8v8" />
              </svg>
              Edges
            </button>
            <button
              className={`tool-btn ${brushTarget === 'exclude' ? 'active' : ''}`}
              onClick={() => setBrushTarget(t => t === 'tattoo' ? 'exclude' : 'tattoo')}
              title="Exclude: Paint over background (wall, sand, clothing) near the tattoo so the AI ignores it when filling skin"
              style={brushTarget === 'exclude' ? { background: '#c06000', color: '#fff' } : {}}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="4" y1="4" x2="20" y2="20" />
              </svg>
              Exclude
            </button>
          </div>

          <div className="toolbar-group">
            <button className="tool-btn" onClick={undo} disabled={!canUndo} title="Undo">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              {undoCount > 0 && <span className="tool-badge">{undoCount}</span>}
            </button>
            <button className="tool-btn" onClick={redo} disabled={!canRedo} title="Redo">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" />
              </svg>
              {redoCount > 0 && <span className="tool-badge">{redoCount}</span>}
            </button>
          </div>

          <div className="toolbar-group">
            <label className="toolbar-slider" title="Brush diameter in pixels">
              <span>Size: {brushSize}</span>
              <input
                type="range"
                min="5"
                max="200"
                value={brushSize}
                onChange={(e) => setBrushSize(parseInt(e.target.value))}
              />
            </label>
            {edgeSnap && (
              <label className="toolbar-slider" title="How aggressively the brush detects tattoo ink — higher values paint over lighter ink and subtle shading">
                <span>Ink: {inkSensitivity}%</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={inkSensitivity}
                  onChange={(e) => setInkSensitivity(parseInt(e.target.value))}
                />
              </label>
            )}
          </div>

          <div className="toolbar-group">
            <button
              className={`tool-btn ${faceBlurEnabled ? 'active' : ''}`}
              onClick={() => setFaceBlurEnabled(v => !v)}
              title="Blur detected faces on apply"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="8" r="5" />
                <path d="M3 21v-2a7 7 0 0 1 14 0v2" />
              </svg>
              Face Blur
            </button>
          </div>
        </div>

        {/* Row 2: Secondary tools */}
        <div className="toolbar-row">
          <div className="toolbar-group">
            <label className="toolbar-slider" title="Grow the mask outward to cover tattoo edges that extend beyond your brush strokes">
              <span>Expand: {expansion}px</span>
              <input
                type="range"
                min="0"
                max="30"
                value={expansion}
                onChange={(e) => setExpansion(parseInt(e.target.value))}
              />
            </label>
            <label className="toolbar-slider" title="Soften the mask edge so the inpainted area blends smoothly into surrounding skin">
              <span>Feather: {feather}px</span>
              <input
                type="range"
                min="0"
                max="40"
                value={feather}
                onChange={(e) => setFeather(parseInt(e.target.value))}
              />
            </label>
          </div>

          <div className="toolbar-group">
            <button className="tool-btn" onClick={handleInvertMask} title="Invert mask">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 2a10 10 0 0 1 0 20" fill="currentColor" />
              </svg>
              Invert
            </button>
            <button
              className={`tool-btn ${showBWMask ? 'active' : ''}`}
              onClick={() => setShowBWMask(v => !v)}
              title="Show mask in black & white"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <rect x="3" y="3" width="9" height="18" fill="currentColor" />
              </svg>
              B&W
            </button>
            <button className="tool-btn" onClick={clearMask} title="Clear tattoo mask">
              Clear
            </button>
            {exclusionMaskCanvasRef.current && (
              <button className="tool-btn" onClick={() => { clearExclusion(); forceRender(); }} title="Clear exclusion mask">
                Clear Excl
              </button>
            )}
          </div>

          <div className="toolbar-group">
            {MASK_COLORS.map((c, i) => (
              <button
                key={c.name}
                className={`mask-color-swatch${i === maskColorIdx ? ' active' : ''}`}
                style={{ background: `rgb(${c.rgb.join(',')})` }}
                onClick={() => setMaskColorIdx(i)}
                title={`${c.name} mask`}
              />
            ))}
          </div>

          {scale > 1 && (
            <div className="toolbar-group">
              <button className="tool-btn" onClick={resetZoom} title="Reset zoom">
                {Math.round(scale * 100)}%
              </button>
            </div>
          )}
        </div>

        {/* Row 3: AI/training tools */}
        <div className="toolbar-row">
          <div className="toolbar-group">
            <select
              className="subject-select"
              value={selectedSubject}
              onChange={(e) => setSelectedSubject(e.target.value)}
              title="Select subject"
            >
              {subjects.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <button className="tool-btn" onClick={handleAddSubject} title="Add new subject">+</button>
          </div>
          <div className="toolbar-group">
            {modelReady && (
              <button
                className="tool-btn"
                onClick={handleSuggestMask}
                disabled={suggesting || isTraining}
                title="Auto-suggest tattoo mask using trained model"
              >
                {suggesting ? 'Suggesting...' : 'Suggest'}
              </button>
            )}
            <button
              className="tool-btn"
              onClick={() => setShowImportModal(true)}
              disabled={isTraining}
              title="Import image+mask training pairs"
            >
              Import
            </button>
            <button
              className="tool-btn"
              onClick={handleTrain}
              disabled={isTraining || pairCount < 2}
              title={pairCount < 2 ? 'Need at least 2 training pairs' : `Train model on ${pairCount} pairs`}
            >
              {isTraining
                ? `Training${trainingProgress ? ` ${trainingProgress.epoch}/${trainingProgress.totalEpochs}` : '...'}`
                : `Train (${pairCount})`}
            </button>
            {modelReady && (
              <button
                className="tool-btn"
                onClick={handleDeleteModel}
                disabled={isTraining}
                title={`Delete model for "${selectedSubject}"`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14H6L5 6" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                  <path d="M9 6V4h6v2" />
                </svg>
              </button>
            )}
            {pairCount > 0 && (
              <button
                className="tool-btn"
                onClick={handleClearTrainingData}
                disabled={isTraining}
                title={`Clear ${pairCount} training pairs for "${selectedSubject}"`}
              >
                Clear Data
              </button>
            )}
          </div>
        </div>

      </div>

      <div className="mobile-zoom-hint">Pinch to zoom &middot; Two-finger pan</div>
      <div
        ref={canvasContainerRef}
        className="mask-editor-canvas-container"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onMouseMove={(e) => setCursorPos({ x: e.clientX, y: e.clientY })}
        onMouseLeave={() => setCursorPos(null)}
      >
        <div
          className="mask-editor-zoom-wrapper"
          style={{ transform: getTransformStyle(), transformOrigin: 'center center' }}
        >
          <canvas
            ref={displayRef}
            className="mask-editor-canvas"
            style={{ cursor: 'none', touchAction: 'none' }}
            onPointerDown={onDown}
          />
        </div>
        {cursorPos && (
          <div
            className="brush-cursor"
            style={{
              width: brushSize * scale,
              height: brushSize * scale,
              left: cursorPos.x,
              top: cursorPos.y,
              borderColor: brushTarget === 'exclude' ? '#ff8800' : activeTool === 'eraser' ? '#ff4466' : '#00ff88',
            }}
          />
        )}
      </div>

      <div className="mask-editor-footer">
        <button className="btn btn-secondary" onClick={handleSkip}>
          Skip Tattoos
        </button>
        <div className="mask-editor-hint">
          {edgeSnap && '(edge snap) '}
          {brushTarget === 'exclude'
            ? 'Exclude mode: Paint over nearby background (wall, sand, clothing) so the AI only uses skin as reference'
            : activeTool === 'brush'
              ? 'Paint over tattoo areas to mark for removal'
              : 'Erase areas to remove from mask'}
          {scale > 1 && ' | Pinch or scroll to zoom, double-tap to reset'}
        </div>
        {applying ? (
          <div className="apply-status-group">
            <span className="apply-status-text">{applyStatus || 'Processing...'}</span>
            <button
              className="btn btn-secondary"
              onClick={() => { setApplying(false); setApplyStatus(''); setScreen('mask-edit'); }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            className="btn btn-primary"
            onClick={handleApply}
          >
            Apply & Continue
          </button>
        )}
      </div>

      {showImportModal && (
        <PairImportModal
          onImport={handleImportPairs}
          onClose={() => setShowImportModal(false)}
        />
      )}
    </div>
  );
}
