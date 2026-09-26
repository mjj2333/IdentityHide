import { describe, it, expect } from 'vitest';
import { routePath } from '../routePath';

describe('routePath', () => {
  it('drops trailing slashes so /faq/ routes like /faq (the host serves faq/index.html for both)', () => {
    expect(routePath('/faq/')).toBe('/faq');
    expect(routePath('/privacy//')).toBe('/privacy');
    expect(routePath('/faq')).toBe('/faq');
  });
  it('leaves the root alone', () => {
    expect(routePath('/')).toBe('/');
    expect(routePath('')).toBe('/');
  });
});
