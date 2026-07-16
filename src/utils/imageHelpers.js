/**
 * Load a File into a canvas, stripping metadata in the process.
 * The browser applies EXIF orientation when drawing to canvas.
 */
export function fileToCanvas(file, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const timer = setTimeout(() => {
      img.onload = img.onerror = null;
      URL.revokeObjectURL(url);
      reject(new Error('Image load timed out'));
    }, timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };
    img.src = url;
  });
}

/**
 * Decode a File directly into a working-resolution canvas, capped by megapixels
 * (tierMP) AND longest-side (maxDim), aligned to /16. Unlike fileToCanvas it
 * draws the decoded <img> STRAIGHT into the small target canvas and never
 * allocates a full-resolution one. On iOS that full-res intermediate (e.g.
 * ~195 MB for a 48 MP photo) is what exhausts the WKWebView canvas-memory pool
 * across a batch — skipping it keeps the pool tiny so toBlob/thumbnails don't
 * throw InvalidStateError. The browser applies EXIF orientation when drawing an
 * <img> to canvas, same as fileToCanvas.
 */
export function fileToWorkingCanvas(file, tierMP = 1, maxDim = 4096, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const timer = setTimeout(() => {
      img.onload = img.onerror = null;
      URL.revokeObjectURL(url);
      reject(new Error('Image load timed out'));
    }, timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      try {
        const iw = img.naturalWidth || img.width;
        const ih = img.naturalHeight || img.height;
        let tw = iw, th = ih;
        const mp = (iw * ih) / 1_000_000;
        if (tierMP && Number.isFinite(tierMP) && mp > tierMP) {
          const s = Math.sqrt(tierMP / mp);
          tw *= s; th *= s;
        }
        const longest = Math.max(tw, th);
        if (maxDim && longest > maxDim) {
          const s = maxDim / longest;
          tw *= s; th *= s;
        }
        // Align to /16 (matches downscaleToMegapixels; Flux VAE stride).
        tw = Math.max(16, Math.round(tw / 16) * 16);
        th = Math.max(16, Math.round(th / 16) * 16);
        const canvas = document.createElement('canvas');
        canvas.width = tw;
        canvas.height = th;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, tw, th); // decode + downscale in one draw
        // Release the decoded bitmap ASAP — iOS holds it otherwise.
        img.onload = img.onerror = null;
        img.src = '';
        URL.revokeObjectURL(url);
        resolve(canvas);
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };
    img.src = url;
  });
}

/**
 * Promise wrapper around canvas.toBlob
 */
export function canvasToBlob(canvas, format = 'image/png', quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob failed'));
      },
      format,
      quality
    );
  });
}

/**
 * Trigger a file download from a Blob
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Downscale a canvas to a target total megapixel count.
 * Dimensions are rounded to the nearest multiple of 16 for Flux VAE
 * stride alignment. Returns { canvas }; the object shape is preserved for
 * forward compatibility even though there's only one field today.
 */
export function downscaleToMegapixels(sourceCanvas, targetMP = 1) {
  const ALIGN = 16; // Flux VAE needs multiples of 16 for stride alignment
  const { width, height } = sourceCanvas;
  const currentMP = (width * height) / 1_000_000;
  if (currentMP <= targetMP) {
    const newW = Math.max(ALIGN, Math.round(width / ALIGN) * ALIGN);
    const newH = Math.max(ALIGN, Math.round(height / ALIGN) * ALIGN);
    if (newW === width && newH === height) {
      return { canvas: sourceCanvas };
    }
    const c = document.createElement('canvas');
    c.width = newW;
    c.height = newH;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sourceCanvas, 0, 0, newW, newH);
    console.log(`[downscale] ${width}x${height} → ${newW}x${newH} (rounded to ${ALIGN}x)`);
    return { canvas: c };
  }
  const scale = Math.sqrt(targetMP / currentMP);
  const newW = Math.max(ALIGN, Math.round((width * scale) / ALIGN) * ALIGN);
  const newH = Math.max(ALIGN, Math.round((height * scale) / ALIGN) * ALIGN);
  const c = document.createElement('canvas');
  c.width = newW;
  c.height = newH;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, newW, newH);
  const actualMP = (newW * newH) / 1_000_000;
  console.log(`[downscale] ${width}x${height} (${currentMP.toFixed(1)}MP) → ${newW}x${newH} (${actualMP.toFixed(2)}MP)`);
  return { canvas: c };
}

/**
 * Cap a canvas so its longest side is <= maxDim, preserving aspect ratio and
 * rounding to multiples of 16 (VAE stride alignment). Returns
 * { canvas, scaled }: `scaled` is false (and `canvas` is the original) when no
 * downscale was needed, so callers can avoid freeing a canvas they still use.
 *
 * Used to keep the working/editing image within a memory- and canvas-size
 * budget — iOS Safari kills the tab when a 12–24MP photo spawns several
 * full-res canvases, and its 2D/WebGL canvases top out around 4096px.
 */
export function capToMaxDimension(sourceCanvas, maxDim) {
  const ALIGN = 16;
  const { width, height } = sourceCanvas;
  const longest = Math.max(width, height);
  if (!maxDim || longest <= maxDim) {
    return { canvas: sourceCanvas, scaled: false };
  }
  const scale = maxDim / longest;
  const newW = Math.max(ALIGN, Math.round((width * scale) / ALIGN) * ALIGN);
  const newH = Math.max(ALIGN, Math.round((height * scale) / ALIGN) * ALIGN);
  const c = document.createElement('canvas');
  c.width = newW;
  c.height = newH;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, newW, newH);
  console.log(`[cap] ${width}x${height} → ${newW}x${newH} (max ${maxDim}px)`);
  return { canvas: c, scaled: true };
}

/**
 * Upscale a canvas to target dimensions using high-quality drawImage.
 */
export function upscaleCanvas(sourceCanvas, targetW, targetH) {
  const c = document.createElement('canvas');
  c.width = targetW;
  c.height = targetH;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, targetW, targetH);
  return c;
}

/**
 * Clamp a bounding box to image dimensions
 */
export function clampRect(rect, width, height) {
  return {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    w: Math.min(Math.round(rect.w), width - Math.max(0, Math.round(rect.x))),
    h: Math.min(Math.round(rect.h), height - Math.max(0, Math.round(rect.y))),
  };
}

/**
 * Expand a rect by a percentage factor (e.g., 0.2 = 20% padding)
 */
export function padRect(rect, factor) {
  const padW = rect.w * factor;
  const padH = rect.h * factor;
  return {
    x: rect.x - padW / 2,
    y: rect.y - padH / 2,
    w: rect.w + padW,
    h: rect.h + padH,
  };
}

/**
 * Generate a sanitized export filename
 */
export function generateExportFilename(format = 'png') {
  const ts = Date.now().toString(36);
  return `img_protected_${ts}.${format}`;
}

