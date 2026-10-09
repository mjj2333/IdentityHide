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

import { saveNativeFile, saveNativeBatch } from '../nativeMedia';

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

describe('saveNativeBatch', () => {
  const items = (names) => async (i) => ({ blob: jpeg(), filename: names[i], mimeType: 'image/jpeg' });
  const cacheWrites = () => fs.writeFile.mock.calls.map(([o]) => o).filter((o) => o.directory === 'CACHE');

  describe('on iOS', () => {
    beforeEach(() => { platform.name = 'ios'; });

    it('opens ONE share sheet holding every photo, not one sheet per photo', async () => {
      const res = await saveNativeBatch(3, items(['a_protected.jpg', 'b_protected.jpg', 'c_protected.jpg']));

      expect(share.share).toHaveBeenCalledTimes(1);
      const opts = share.share.mock.calls[0][0];
      expect(opts.files).toEqual([
        'file:///x/a_protected.jpg', 'file:///x/b_protected.jpg', 'file:///x/c_protected.jpg',
      ]);
      expect(opts.url).toBeUndefined();
      expect(res).toEqual({ outcome: 'shared', count: 3, failed: 0 });
    });

    it('keeps photos apart when the picker gave them all the same name', async () => {
      await saveNativeBatch(3, items(['image_protected.jpg', 'image_protected.jpg', 'image_protected.jpg']));

      const paths = cacheWrites().map((o) => o.path);
      expect(new Set(paths).size).toBe(3);
      expect(share.share.mock.calls[0][0].files).toHaveLength(3);
    });

    it('shares the rest and counts the loss when one photo cannot be produced', async () => {
      const res = await saveNativeBatch(3, async (i) => {
        if (i === 1) return null;
        if (i === 2) throw new Error('encode failed');
        return { blob: jpeg(), filename: 'a_protected.jpg', mimeType: 'image/jpeg' };
      });

      expect(share.share.mock.calls[0][0].files).toHaveLength(1);
      expect(res).toEqual({ outcome: 'shared', count: 1, failed: 2 });
    });

    it('does not open an empty share sheet when nothing could be produced', async () => {
      const res = await saveNativeBatch(2, async () => null);

      expect(share.share).not.toHaveBeenCalled();
      expect(res).toEqual({ outcome: 'shared', count: 0, failed: 2 });
    });

    it('reports a dismissed sheet as cancelled and cleans up its temp files', async () => {
      share.share.mockRejectedValue(new Error('Share canceled'));

      const res = await saveNativeBatch(2, items(['a.jpg', 'b.jpg']));

      expect(res).toEqual({ outcome: 'cancelled', count: 0, failed: 0 });
      expect(fs.deleteFile).toHaveBeenCalledTimes(2);
    });

    it('surfaces a real share failure instead of hiding it', async () => {
      share.share.mockRejectedValue(new Error("Can't share while sharing is in progress"));

      await expect(saveNativeBatch(2, items(['a.jpg', 'b.jpg']))).rejects.toThrow('sharing is in progress');
      expect(fs.deleteFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('on Android', () => {
    it('writes every photo straight into the gallery folder', async () => {
      const res = await saveNativeBatch(3, items(['a.jpg', 'b.jpg', 'c.jpg']));

      expect(publicWrites().map((o) => o.path)).toEqual([
        'Pictures/RedactID/a.jpg', 'Pictures/RedactID/b.jpg', 'Pictures/RedactID/c.jpg',
      ]);
      expect(share.share).not.toHaveBeenCalled();
      expect(res).toEqual({ outcome: 'saved', folder: 'Pictures/RedactID', count: 3, failed: 0 });
    });

    it('counts a photo that fails part-way and carries on', async () => {
      fs.writeFile.mockImplementation(async ({ path }) => {
        if (path.includes('/b')) throw new Error('disk error');
        return { uri: `file:///x/${path}` };
      });

      const res = await saveNativeBatch(3, items(['a.jpg', 'b.jpg', 'c.jpg']));

      expect(res).toEqual({ outcome: 'saved', folder: 'Pictures/RedactID', count: 2, failed: 1 });
    });

    it('uses one share sheet for the whole batch when the gallery cannot be written (older Android)', async () => {
      fs.writeFile.mockImplementation(async ({ directory, path }) => {
        if (directory === 'EXTERNAL_STORAGE') throw new Error('permission denied');
        return { uri: `file:///cache/${path}` };
      });

      const res = await saveNativeBatch(2, items(['a.jpg', 'b.jpg']));

      expect(share.share).toHaveBeenCalledTimes(1);
      expect(share.share.mock.calls[0][0].files).toHaveLength(2);
      expect(res).toEqual({ outcome: 'shared', count: 2, failed: 0 });
    });
  });
});
