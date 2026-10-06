// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fs = vi.hoisted(() => ({ writeFile: vi.fn(), deleteFile: vi.fn(), stat: vi.fn() }));
const share = vi.hoisted(() => ({ share: vi.fn() }));
const platform = vi.hoisted(() => ({ name: 'android' }));

vi.mock('@capacitor/filesystem', () => ({
  Filesystem: fs,
  Directory: { Cache: 'CACHE', ExternalStorage: 'EXTERNAL_STORAGE' },
}));
vi.mock('@capacitor/share', () => ({ Share: share }));
vi.mock('../platform', () => ({
  isNativeApp: () => true,
  getNativePlatform: () => platform.name,
}));

import { saveNativeFile } from '../nativeMedia';

const jpeg = () => new Blob(['fake-jpeg-bytes'], { type: 'image/jpeg' });
const publicWrites = () => fs.writeFile.mock.calls.map(([o]) => o).filter((o) => o.directory === 'EXTERNAL_STORAGE');

beforeEach(() => {
  platform.name = 'android';
  fs.writeFile.mockReset().mockImplementation(async ({ path }) => ({ uri: `file:///x/${path}` }));
  fs.deleteFile.mockReset().mockResolvedValue();
  // By default nothing exists yet under the chosen name.
  fs.stat.mockReset().mockRejectedValue(new Error('File does not exist'));
  share.share.mockReset().mockResolvedValue({ activityType: 'some.app' });
});

describe('saveNativeFile on Android', () => {
  it('writes a photo straight into the gallery folder, without opening the share sheet', async () => {
    const res = await saveNativeFile(jpeg(), 'img_protected_abc.jpg', 'image/jpeg');

    expect(publicWrites()).toHaveLength(1);
    expect(publicWrites()[0]).toMatchObject({ path: 'Pictures/RedactID/img_protected_abc.jpg', recursive: true });
    expect(publicWrites()[0].data).toBe(btoa('fake-jpeg-bytes'));
    expect(share.share).not.toHaveBeenCalled();
    expect(res).toEqual({ outcome: 'saved', folder: 'Pictures/RedactID' });
  });

  it('puts a ZIP in Downloads, since it is not a photo', async () => {
    const res = await saveNativeFile(new Blob(['zip']), 'redactid_batch_1.zip', 'application/zip');

    expect(publicWrites()[0].path).toBe('Download/RedactID/redactid_batch_1.zip');
    expect(res).toEqual({ outcome: 'saved', folder: 'Download/RedactID' });
  });

  it('never overwrites a photo already saved under the same name', async () => {
    fs.stat.mockResolvedValue({ type: 'file' });

    await saveNativeFile(jpeg(), 'beach_protected.jpg', 'image/jpeg');

    const { path } = publicWrites()[0];
    expect(path).not.toBe('Pictures/RedactID/beach_protected.jpg');
    expect(path).toMatch(/^Pictures\/RedactID\/beach_protected_[a-z0-9]+\.jpg$/);
  });

  it('retries once under a fresh name when the write is refused', async () => {
    fs.writeFile.mockRejectedValueOnce(new Error('EACCES'));

    const res = await saveNativeFile(jpeg(), 'beach_protected.jpg', 'image/jpeg');

    expect(publicWrites()).toHaveLength(2);
    expect(publicWrites()[1].path).toMatch(/^Pictures\/RedactID\/beach_protected_[a-z0-9]+\.jpg$/);
    expect(res.outcome).toBe('saved');
  });

  it('falls back to the share sheet when the gallery cannot be written (older Android)', async () => {
    fs.writeFile.mockImplementation(async ({ directory, path }) => {
      if (directory === 'EXTERNAL_STORAGE') throw new Error('Unable to do file operation, user denied permission request');
      return { uri: `file:///cache/${path}` };
    });

    const res = await saveNativeFile(jpeg(), 'img_protected_abc.jpg', 'image/jpeg');

    expect(share.share).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ outcome: 'shared' });
  });

  it('reports a failure when neither the gallery nor the share sheet works', async () => {
    fs.writeFile.mockRejectedValue(new Error('disk full'));

    await expect(saveNativeFile(jpeg(), 'img_protected_abc.jpg', 'image/jpeg')).rejects.toThrow('disk full');
  });
});

describe('saveNativeFile on iOS', () => {
  beforeEach(() => { platform.name = 'ios'; });

  it('keeps using the share sheet, which offers "Save Image"', async () => {
    const res = await saveNativeFile(jpeg(), 'img_protected_abc.jpg', 'image/jpeg');

    expect(publicWrites()).toHaveLength(0);
    expect(share.share).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ outcome: 'shared' });
  });

  it('reports a dismissed share sheet as cancelled', async () => {
    share.share.mockRejectedValue(new Error('Share canceled'));

    expect(await saveNativeFile(jpeg(), 'img_protected_abc.jpg', 'image/jpeg')).toEqual({ outcome: 'cancelled' });
  });
});
