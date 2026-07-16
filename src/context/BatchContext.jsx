import { createContext, useContext, useState, useCallback, useMemo, useRef } from 'react';

function makeId() {
  try { return crypto.randomUUID(); } catch {}
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const BatchContext = createContext(null);

export function BatchProvider({ children }) {
  // Array of batch image entries
  const [images, setImages] = useState([]);
  // Global blur settings applied to all images (unless per-image override)
  const [globalBlurSettings, setGlobalBlurSettings] = useState({ mode: 'gaussian', stickerEnabled: false, strength: 20, barWidth: 20, barLength: 110, barAngle: 0, barStyle: 'solid', barColor: '#000000' });
  const [globalFeather, setGlobalFeather] = useState(0);
  // Which image is currently open in the editor (null = grid view)
  const [activeImageId, setActiveImageId] = useState(null);
  // Overall batch status
  const [batchStatus, setBatchStatus] = useState('idle'); // idle | detecting | ready | processing | done | error
  const [processedCount, setProcessedCount] = useState(0);
  // Per-image progress string during processing ('Inpainting step 14/28', 'Blurring faces...')
  // Surfaced by BatchGridScreen under the batch progress bar. Null when idle.
  const [currentImageLabel, setCurrentImageLabel] = useState(null);

  // Unsaved-edits flag for BatchEditorScreen. Exposed as a ref so ScreenRouter's
  // popstate handler can read it without the component owning the flag needing
  // to publish every keystroke through context (which would re-render the whole
  // app tree on each edit). BatchEditorScreen sets this to true when the user
  // changes any editing state, and clears it on unmount.
  const batchDirtyRef = useRef(false);

  // Add images to the batch. `cap` is the max total the batch may hold (20
  // for premium, 3 for the free tier). Enforced HERE so every entry path
  // (home-screen seed, in-grid "add more") shares one ceiling; callers pass
  // the tier cap. Defaults to 20 so any un-tiered caller stays bounded.
  const addImages = useCallback((newEntries, cap = 20) => {
    setImages(prev => {
      const combined = [...prev, ...newEntries];
      return combined.slice(0, cap);
    });
  }, []);

  // Seed batch from raw File objects (used by DropZone on multi-file upload).
  // Builds entry objects and adds them — replaces the old window.__batchFiles hack.
  const seedFiles = useCallback((files, cap = 20) => {
    const entries = files.map(file => ({
      id: makeId(),
      file,
      status: 'pending',
      detections: [],
      editDetections: null,
      blurSettings: null,
      strippedCanvas: null,
      thumbnailCanvas: null,
      outputCanvas: null,
      tattooMaskCanvas: null,
      error: null,
    }));
    addImages(entries, cap);
  }, [addImages]);

  // Remove an image by id
  const removeImage = useCallback((id) => {
    setImages(prev => {
      const removed = prev.find(img => img.id === id);
      if (removed) {
        if (removed.strippedCanvas) { removed.strippedCanvas.width = 0; removed.strippedCanvas.height = 0; }
        if (removed.outputCanvas) { removed.outputCanvas.width = 0; removed.outputCanvas.height = 0; }
        if (removed.thumbnailCanvas) { removed.thumbnailCanvas.width = 0; removed.thumbnailCanvas.height = 0; }
        if (removed.cleanThumbCanvas && removed.cleanThumbCanvas !== removed.thumbnailCanvas) { removed.cleanThumbCanvas.width = 0; removed.cleanThumbCanvas.height = 0; }
        if (removed.faceBlurCanvas) { removed.faceBlurCanvas.width = 0; removed.faceBlurCanvas.height = 0; }
        if (removed.tattooMaskCanvas) { removed.tattooMaskCanvas.width = 0; removed.tattooMaskCanvas.height = 0; }
        if (removed.thumbnailUrl) URL.revokeObjectURL(removed.thumbnailUrl);
      }
      return prev.filter(img => img.id !== id);
    });
  }, []);

  // Update a single image entry
  const updateImage = useCallback((id, updates) => {
    setImages(prev => prev.map(img =>
      img.id === id ? { ...img, ...updates } : img
    ));
  }, []);

  // Reset batch (clear everything)
  const resetBatch = useCallback(() => {
    // Free canvas memory
    setImages(prev => {
      for (const img of prev) {
        if (img.strippedCanvas) { img.strippedCanvas.width = 0; img.strippedCanvas.height = 0; }
        if (img.outputCanvas) { img.outputCanvas.width = 0; img.outputCanvas.height = 0; }
        if (img.thumbnailCanvas) { img.thumbnailCanvas.width = 0; img.thumbnailCanvas.height = 0; }
        if (img.cleanThumbCanvas && img.cleanThumbCanvas !== img.thumbnailCanvas) { img.cleanThumbCanvas.width = 0; img.cleanThumbCanvas.height = 0; }
        if (img.faceBlurCanvas) { img.faceBlurCanvas.width = 0; img.faceBlurCanvas.height = 0; }
        if (img.tattooMaskCanvas) { img.tattooMaskCanvas.width = 0; img.tattooMaskCanvas.height = 0; }
        if (img.thumbnailUrl) URL.revokeObjectURL(img.thumbnailUrl);
      }
      return [];
    });
    setActiveImageId(null);
    setBatchStatus('idle');
    setProcessedCount(0);
    setCurrentImageLabel(null);
    setGlobalBlurSettings({ mode: 'gaussian', stickerEnabled: false, strength: 20, barWidth: 20, barLength: 110, barAngle: 0, barStyle: 'solid', barColor: '#000000' });
    setGlobalFeather(0);
  }, []);

  const value = useMemo(() => ({
    images, setImages,
    globalBlurSettings, setGlobalBlurSettings,
    globalFeather, setGlobalFeather,
    activeImageId, setActiveImageId,
    batchStatus, setBatchStatus,
    processedCount, setProcessedCount,
    currentImageLabel, setCurrentImageLabel,
    batchDirtyRef,
    addImages,
    seedFiles,
    removeImage,
    updateImage,
    resetBatch,
  }), [
    images, globalBlurSettings, globalFeather, activeImageId,
    batchStatus, processedCount, currentImageLabel, addImages, seedFiles, removeImage, updateImage, resetBatch,
  ]);

  return (
    <BatchContext.Provider value={value}>
      {children}
    </BatchContext.Provider>
  );
}

export function useBatch() {
  const ctx = useContext(BatchContext);
  if (!ctx) throw new Error('useBatch must be used within BatchProvider');
  return ctx;
}
