import { describe, it, expect } from 'vitest';
import { bumpCanvasRevision, getCanvasRevision } from '../canvasRevision';

describe('canvas revision counter', () => {
  it('starts at 0 for a canvas that was never painted on', () => {
    expect(getCanvasRevision({})).toBe(0);
  });

  it('increases every time the canvas is marked as painted', () => {
    const c = {};
    bumpCanvasRevision(c);
    bumpCanvasRevision(c);
    expect(getCanvasRevision(c)).toBe(2);
  });

  it('tracks each canvas separately', () => {
    const a = {}, b = {};
    bumpCanvasRevision(a);
    expect(getCanvasRevision(b)).toBe(0);
  });

  it('ignores a missing canvas', () => {
    expect(() => bumpCanvasRevision(null)).not.toThrow();
    expect(getCanvasRevision(null)).toBe(0);
  });
});
