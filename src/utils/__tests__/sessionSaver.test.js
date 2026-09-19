import { describe, it, expect, vi } from 'vitest';
import { createSessionSaver } from '../sessionSaver';
import { bumpCanvasRevision } from '../canvasRevision';

// Plain objects stand in for canvases: the saver only looks at identity,
// width/height, and the revision counter — it never draws.
const canvas = (w = 1152, h = 864) => ({ width: w, height: h });

function harness() {
  const writes = [];
  const encode = vi.fn(async (c, slot) => `png:${slot}:${c.width}x${c.height}`);
  const write = vi.fn(async (batch) => { writes.push(batch); });
  return { writes, encode, write, saver: createSessionSaver({ encode, write }) };
}

const snapshot = (over = {}) => ({
  meta: { screen: 'mask-edit', feather: 0, editDets: [] },
  originalFile: { name: 'photo.jpg' },
  canvases: { stripped: canvas(), output: canvas(), tattooMask: canvas(), inpainted: null },
  ...over,
});

describe('createSessionSaver', () => {
  it('writes everything on the first save', async () => {
    const { saver, encode, writes } = harness();
    const snap = snapshot();
    await saver.save(() => snap);
    expect(encode).toHaveBeenCalledTimes(3); // inpainted is null
    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0].put).sort()).toEqual(
      ['canvas:output', 'canvas:stripped', 'canvas:tattooMask', 'meta', 'originalFile'],
    );
    expect(writes[0].put.originalFile).toBe(snap.originalFile);
    expect(writes[0].put.meta.screen).toBe('mask-edit');
    expect(typeof writes[0].put.meta.savedAt).toBe('number');
  });

  it('does nothing at all when nothing changed', async () => {
    const { saver, encode, write } = harness();
    const snap = snapshot();
    await saver.save(() => snap);
    encode.mockClear(); write.mockClear();
    await saver.save(() => snap);
    expect(encode).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('writes only the settings when only settings changed (slider / region edits)', async () => {
    const { saver, encode, writes } = harness();
    const snap = snapshot();
    await saver.save(() => snap);
    encode.mockClear();
    await saver.save(() => ({ ...snap, meta: { ...snap.meta, feather: 12 } }));
    expect(encode).not.toHaveBeenCalled();
    expect(Object.keys(writes[1].put)).toEqual(['meta']);
    expect(writes[1].put.meta.feather).toBe(12);
  });

  it('re-encodes only the canvas that was replaced', async () => {
    const { saver, encode, writes } = harness();
    const snap = snapshot();
    await saver.save(() => snap);
    encode.mockClear();
    const next = { ...snap, canvases: { ...snap.canvases, output: canvas() } };
    await saver.save(() => next);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(encode.mock.calls[0][1]).toBe('output');
    expect(Object.keys(writes[1].put).sort()).toEqual(['canvas:output', 'meta']);
  });

  it('re-encodes a canvas that was painted on in place', async () => {
    const { saver, encode } = harness();
    const snap = snapshot();
    await saver.save(() => snap);
    encode.mockClear();
    bumpCanvasRevision(snap.canvases.tattooMask);
    await saver.save(() => snap);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(encode.mock.calls[0][1]).toBe('tattooMask');
  });

  it('removes a stored canvas once it is gone or emptied (e.g. freed with width = 0)', async () => {
    const { saver, writes } = harness();
    const snap = snapshot({ canvases: { stripped: canvas(), inpainted: canvas() } });
    await saver.save(() => snap);
    snap.canvases.inpainted.width = 0;
    await saver.save(() => snap);
    expect(writes[1].remove).toEqual(['canvas:inpainted']);
  });

  it('stores the uploaded file once per image, not on every save', async () => {
    const { saver, writes } = harness();
    const snap = snapshot();
    await saver.save(() => snap);
    await saver.save(() => ({ ...snap, meta: { ...snap.meta, feather: 3 } }));
    expect('originalFile' in writes[1].put).toBe(false);
    await saver.save(() => ({ ...snap, originalFile: { name: 'other.jpg' } }));
    expect(writes[2].put.originalFile).toEqual({ name: 'other.jpg' });
  });

  it('treats a just-restored session as already saved', async () => {
    const { saver, encode, write } = harness();
    const snap = snapshot();
    saver.adopt(snap);
    await saver.save(() => snap);
    expect(encode).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('retries everything that failed to write', async () => {
    const { saver, encode, write } = harness();
    const snap = snapshot();
    write.mockRejectedValueOnce(new Error('QuotaExceededError'));
    await expect(saver.save(() => snap)).rejects.toThrow('QuotaExceededError');
    encode.mockClear();
    await saver.save(() => snap);
    expect(encode).toHaveBeenCalledTimes(3);
  });

  it('never runs two saves at once; a request made mid-save runs once afterwards with the latest state', async () => {
    const { saver, write } = harness();
    let releaseFirst;
    write.mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }));
    const snap = snapshot();
    let feather = 1;
    const getSnapshot = vi.fn(() => ({ ...snap, meta: { ...snap.meta, feather } }));

    const first = saver.save(getSnapshot);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    feather = 2; const second = saver.save(getSnapshot);
    feather = 3; const third = saver.save(getSnapshot);
    expect(write).toHaveBeenCalledTimes(1); // still only the first, in flight

    releaseFirst();
    await Promise.all([first, second, third]);
    expect(write).toHaveBeenCalledTimes(2); // the two queued requests collapsed into one
    expect(write.mock.calls[1][0].put.meta.feather).toBe(3);
  });

  it('drops a save that reset() overtakes, so Start Over cannot resurrect the old session', async () => {
    const { saver, encode, write } = harness();
    let releaseEncode;
    encode.mockImplementationOnce(() => new Promise((resolve) => { releaseEncode = () => resolve('png'); }));
    const pending = saver.save(() => snapshot());
    await vi.waitFor(() => expect(encode).toHaveBeenCalledTimes(1));
    saver.reset();
    releaseEncode();
    await pending;
    expect(write).not.toHaveBeenCalled();
  });

  it('reset forgets what was saved so the next image is written in full', async () => {
    const { saver, encode } = harness();
    const snap = snapshot();
    await saver.save(() => snap);
    saver.reset();
    encode.mockClear();
    await saver.save(() => snap);
    expect(encode).toHaveBeenCalledTimes(3);
  });
});
