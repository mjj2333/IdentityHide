import { describe, it, expect } from 'vitest';
import { extractMetadata } from '../metadataExtractor';

// Helper to build an ArrayBuffer from byte arrays
function makeBuffer(bytes) {
  return new Uint8Array(bytes).buffer;
}

describe('extractMetadata', () => {
  it('returns null for tiny buffers', async () => {
    const result = await extractMetadata(makeBuffer([0x00, 0x00]));
    expect(result).toBeNull();
  });

  it('detects PNG format', async () => {
    // PNG magic: 0x89 0x50 0x4E 0x47
    const result = await extractMetadata(makeBuffer([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0]));
    expect(result).not.toBeNull();
    expect(result.format).toBe('PNG');
    expect(result.readable).toBe(false);
    expect(result.note).toContain('PNG');
  });

  it('detects WebP format', async () => {
    // RIFF....WEBP
    const riff = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
    const size = [0x00, 0x00, 0x00, 0x00];
    const webp = [0x57, 0x45, 0x42, 0x50]; // "WEBP"
    const result = await extractMetadata(makeBuffer([...riff, ...size, ...webp]));
    expect(result).not.toBeNull();
    expect(result.format).toBe('WebP');
    expect(result.readable).toBe(false);
  });

  it('detects HEIC format', async () => {
    // ftyp box at offset 4, brand "heic" at offset 8
    const size = [0x00, 0x00, 0x00, 0x18]; // box size
    const ftyp = [0x66, 0x74, 0x79, 0x70]; // "ftyp"
    const brand = [0x68, 0x65, 0x69, 0x63]; // "heic"
    const result = await extractMetadata(makeBuffer([...size, ...ftyp, ...brand, 0, 0, 0, 0]));
    expect(result).not.toBeNull();
    expect(result.format).toBe('HEIC');
    expect(result.readable).toBe(false);
  });

  it('returns unknown for unrecognized formats', async () => {
    const result = await extractMetadata(makeBuffer([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]));
    expect(result).not.toBeNull();
    expect(result.format).toBeNull();
    expect(result.readable).toBe(false);
    expect(result.note).toContain('metadata is removed on export');
  });

  it('detects JPEG without EXIF', async () => {
    // JPEG SOI marker + non-APP1 marker
    const result = await extractMetadata(makeBuffer([
      0xFF, 0xD8, // SOI
      0xFF, 0xE0, // APP0 (JFIF, not EXIF)
      0x00, 0x10, // segment length
      ...new Array(14).fill(0x00), // padding
    ]));
    expect(result).not.toBeNull();
    expect(result.format).toBe('JPEG');
    expect(result.readable).toBe(true);
  });

  it('handles File objects via arrayBuffer()', async () => {
    const buf = makeBuffer([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0]);
    const file = { arrayBuffer: () => Promise.resolve(buf) };
    const result = await extractMetadata(file);
    expect(result.format).toBe('PNG');
  });
});
