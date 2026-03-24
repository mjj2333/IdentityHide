import { useState, useCallback, useRef } from 'react';

/**
 * Modal for visually pairing image+mask files for training data import.
 * User selects files, sees thumbnails, clicks to pair image→mask.
 */
export default function PairImportModal({ onImport, onClose }) {
  const [files, setFiles] = useState([]); // { id, file, url, paired: null|id }
  const [selectedId, setSelectedId] = useState(null); // id of first click (image)
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);
  const nextId = useRef(0);

  const handleAddFiles = useCallback((e) => {
    const newFiles = Array.from(e.target.files || []);
    if (!newFiles.length) return;
    setFiles(prev => [
      ...prev,
      ...newFiles.map(f => ({
        id: nextId.current++,
        file: f,
        url: URL.createObjectURL(f),
        paired: null,
        role: null, // 'image' | 'mask'
      })),
    ]);
    e.target.value = '';
  }, []);

  const handleClick = useCallback((id) => {
    if (importing) return;

    setFiles(prev => {
      const clicked = prev.find(f => f.id === id);
      if (!clicked) return prev;

      // If clicking on already-paired item, unpair it
      if (clicked.paired !== null) {
        return prev.map(f => {
          if (f.id === id || f.id === clicked.paired) {
            return { ...f, paired: null, role: null };
          }
          return f;
        });
      }

      // No selection yet — select this as the image
      if (selectedId === null) {
        setSelectedId(id);
        return prev;
      }

      // Clicking the same item — deselect
      if (selectedId === id) {
        setSelectedId(null);
        return prev;
      }

      // Second click — pair them
      const updated = prev.map(f => {
        if (f.id === selectedId) return { ...f, paired: id, role: 'image' };
        if (f.id === id) return { ...f, paired: selectedId, role: 'mask' };
        return f;
      });
      setSelectedId(null);
      return updated;
    });
  }, [selectedId, importing]);

  const pairs = files.filter(f => f.role === 'image' && f.paired !== null).map(img => {
    const mask = files.find(f => f.id === img.paired);
    return { image: img, mask };
  }).filter(p => p.mask);

  const unpaired = files.filter(f => f.paired === null);

  const handleImport = useCallback(async () => {
    if (!pairs.length) return;
    setImporting(true);
    await onImport(pairs.map(p => ({ imageFile: p.image.file, maskFile: p.mask.file })));
    // Clean up object URLs
    files.forEach(f => URL.revokeObjectURL(f.url));
    setImporting(false);
    onClose();
  }, [pairs, files, onImport, onClose]);

  const handleRemove = useCallback((id) => {
    setFiles(prev => {
      const item = prev.find(f => f.id === id);
      if (!item) return prev;
      URL.revokeObjectURL(item.url);
      // Also unpair partner
      const updated = prev.filter(f => f.id !== id).map(f => {
        if (f.paired === id) return { ...f, paired: null, role: null };
        return f;
      });
      return updated;
    });
    if (selectedId === id) setSelectedId(null);
  }, [selectedId]);

  return (
    <div className="pair-import-overlay" onClick={onClose}>
      <div className="pair-import-modal" onClick={e => e.stopPropagation()}>
        <div className="pair-import-header">
          <h3>Import Training Pairs</h3>
          <button className="pair-import-close" onClick={onClose}>&times;</button>
        </div>

        <div className="pair-import-instructions">
          {files.length === 0
            ? 'Add image and mask files, then click to pair them.'
            : selectedId !== null
              ? 'Now click the corresponding mask image to complete the pair.'
              : 'Click an image first, then click its mask to pair them. Click a paired item to unpair.'}
        </div>

        {/* Paired section */}
        {pairs.length > 0 && (
          <div className="pair-import-section">
            <div className="pair-import-section-label">Paired ({pairs.length})</div>
            <div className="pair-import-pairs">
              {pairs.map(({ image, mask }) => (
                <div key={image.id} className="pair-import-pair">
                  <div
                    className="pair-import-thumb paired"
                    onClick={() => handleClick(image.id)}
                    title={`Image: ${image.file.name} (click to unpair)`}
                  >
                    <img src={image.url} alt={image.file.name} />
                    <span className="pair-import-label">IMG</span>
                  </div>
                  <span className="pair-import-arrow">&harr;</span>
                  <div
                    className="pair-import-thumb paired"
                    onClick={() => handleClick(mask.id)}
                    title={`Mask: ${mask.file.name} (click to unpair)`}
                  >
                    <img src={mask.url} alt={mask.file.name} />
                    <span className="pair-import-label">MASK</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Unpaired section */}
        {unpaired.length > 0 && (
          <div className="pair-import-section">
            <div className="pair-import-section-label">Unpaired ({unpaired.length})</div>
            <div className="pair-import-grid">
              {unpaired.map(f => (
                <div
                  key={f.id}
                  className={`pair-import-thumb ${selectedId === f.id ? 'selected' : ''}`}
                  onClick={() => handleClick(f.id)}
                  title={f.file.name}
                >
                  <img src={f.url} alt={f.file.name} />
                  <span className="pair-import-name">{f.file.name}</span>
                  <button
                    className="pair-import-remove"
                    onClick={(e) => { e.stopPropagation(); handleRemove(f.id); }}
                    title="Remove"
                  >&times;</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="pair-import-footer">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={handleAddFiles}
          />
          <button
            className="btn btn-secondary"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
          >
            Add Files
          </button>
          <button
            className="btn btn-primary"
            onClick={handleImport}
            disabled={importing || pairs.length === 0}
          >
            {importing ? 'Importing...' : `Import ${pairs.length} Pair${pairs.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
