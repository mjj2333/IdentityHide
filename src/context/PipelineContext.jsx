import { createContext, useContext, useState, useRef, useCallback } from 'react';

const PipelineContext = createContext(null);

export function PipelineProvider({ children }) {
  const [screen, setScreen] = useState('drop');
  const [originalFile, setOriginalFile] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [detections, setDetections] = useState([]);
  const [detectionToggles, setDetectionToggles] = useState([]);
  const [blurSettings, setBlurSettings] = useState({ mode: 'gaussian', strength: 20 });
  const [brushSettings, setBrushSettings] = useState({ tool: 'brush', size: 30 });
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);

  const strippedCanvasRef = useRef(null);
  const originalCanvasRef = useRef(null);
  const maskCanvasRef = useRef(null);
  const outputCanvasRef = useRef(null);
  const tattooMaskCanvasRef = useRef(null);
  const exclusionMaskCanvasRef = useRef(null);
  const samScaleRef = useRef(null);
  const inpaintedCanvasRef = useRef(null);

  const reset = useCallback(() => {
    setScreen('drop');
    setOriginalFile(null);
    setMetadata(null);
    setDetections([]);
    setDetectionToggles([]);
    setBlurSettings({ mode: 'gaussian', strength: 20 });
    setBrushSettings({ tool: 'brush', size: 30 });
    setStatus('idle');
    setError(null);
    strippedCanvasRef.current = null;
    originalCanvasRef.current = null;
    maskCanvasRef.current = null;
    outputCanvasRef.current = null;
    tattooMaskCanvasRef.current = null;
    exclusionMaskCanvasRef.current = null;
    samScaleRef.current = null;
    inpaintedCanvasRef.current = null;
  }, []);

  const value = {
    screen, setScreen,
    originalFile, setOriginalFile,
    metadata, setMetadata,
    detections, setDetections,
    detectionToggles, setDetectionToggles,
    blurSettings, setBlurSettings,
    brushSettings, setBrushSettings,
    status, setStatus,
    error, setError,
    strippedCanvasRef,
    originalCanvasRef,
    maskCanvasRef,
    outputCanvasRef,
    tattooMaskCanvasRef,
    exclusionMaskCanvasRef,
    samScaleRef,
    inpaintedCanvasRef,
    reset,
  };

  return (
    <PipelineContext.Provider value={value}>
      {children}
    </PipelineContext.Provider>
  );
}

export function usePipeline() {
  const ctx = useContext(PipelineContext);
  if (!ctx) throw new Error('usePipeline must be used within PipelineProvider');
  return ctx;
}
