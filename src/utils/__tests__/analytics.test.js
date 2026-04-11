// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch
const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
vi.stubGlobal('fetch', fetchMock);

// Force production mode so track() actually calls fetch
vi.stubEnv('DEV', false);
vi.stubEnv('MODE', 'production');

// Must dynamically import after stubs are in place
const { track } = await import('../analytics');

describe('track', () => {
  beforeEach(() => {
    fetchMock.mockClear();
  });

  it('sends event to the track endpoint', async () => {
    track('app_loaded', { device: 'desktop' });
    await new Promise(r => setTimeout(r, 10));
    expect(fetchMock).toHaveBeenCalled();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/.netlify/functions/track');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.event).toBe('app_loaded');
    expect(body.properties.device).toBe('desktop');
  });

  it('includes session_id in payload', async () => {
    track('image_uploaded');
    await new Promise(r => setTimeout(r, 10));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.session_id).toBeDefined();
    expect(typeof body.session_id).toBe('string');
  });
});
