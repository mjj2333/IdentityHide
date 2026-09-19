/**
 * Per-canvas "painted on" counter.
 *
 * Most pipeline canvases only ever change by being REPLACED with a new canvas
 * object, which is detectable by identity. The tattoo mask is the exception:
 * brush strokes, undo/redo and clear all mutate it in place. Code that mutates
 * a canvas in place calls bumpCanvasRevision() so the session saver can tell
 * the pixels changed without reading them back.
 *
 * WeakMap-keyed, so a discarded canvas takes its counter with it.
 */
const revisions = new WeakMap();

export function bumpCanvasRevision(canvas) {
  if (!canvas) return;
  revisions.set(canvas, (revisions.get(canvas) || 0) + 1);
}

export function getCanvasRevision(canvas) {
  return (canvas && revisions.get(canvas)) || 0;
}
