import { describe, it, expect } from 'vitest';
import { savedMessage, isCancelError } from '../exportMessages';

describe('savedMessage', () => {
  it('tells the user where one photo went', () => {
    expect(savedMessage(1, 'Pictures/RedactID')).toBe('Saved to your gallery, in the RedactID album.');
  });

  it('counts the photos in a batch', () => {
    expect(savedMessage(3, 'Pictures/RedactID')).toBe('Saved 3 photos to your gallery, in the RedactID album.');
  });

  it('points to Downloads for a file that is not a photo', () => {
    expect(savedMessage(1, 'Download/RedactID')).toBe('Saved to your Downloads, in the RedactID folder.');
  });
});

describe('isCancelError', () => {
  it('recognises a dismissed share sheet', () => {
    expect(isCancelError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isCancelError(new Error('Share canceled'))).toBe(true);
    expect(isCancelError(new Error('User cancelled'))).toBe(true);
  });

  it('does not hide real failures', () => {
    expect(isCancelError(new Error('disk full'))).toBe(false);
    expect(isCancelError(undefined)).toBe(false);
  });
});
