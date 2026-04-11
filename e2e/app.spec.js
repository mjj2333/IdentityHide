import { test, expect } from '@playwright/test';
import zlib from 'node:zlib';
import { ACTION_TIMEOUT_MS } from './test-utils.js';

test.describe('Landing page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('shows drop zone with title and tagline', async ({ page }) => {
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('.dropzone-tagline')).toBeVisible();
    await expect(page.locator('.dropzone-target')).toBeVisible();
  });

  test('drop zone has accessible role and label', async ({ page }) => {
    const target = page.locator('.dropzone-target');
    await expect(target).toBeVisible();
    await expect(target).toHaveAttribute('aria-label', 'Upload an image');
    // The target is a native <button>, which has an implicit ARIA role of
    // "button". Checking tagName preserves the original intent (semantic /
    // accessible markup) without requiring an explicit role="button" attr.
    const tag = await target.evaluate((el) => el.tagName);
    expect(tag).toBe('BUTTON');
  });

  test('file inputs have aria-labels', async ({ page }) => {
    const inputs = page.locator('input[type="file"]');
    const count = await inputs.count();
    expect(count).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < count; i++) {
      await expect(inputs.nth(i)).toHaveAttribute('aria-label', /.+/);
    }
  });

  test('feature list is visible', async ({ page }) => {
    const features = page.locator('.dropzone-features .feature');
    await expect(features).toHaveCount(3);
  });

  test('camera button is visible', async ({ page }) => {
    await expect(page.locator('.camera-btn')).toBeVisible();
  });

  test('feedback link points to /feedback', async ({ page }) => {
    const link = page.locator('.dropzone-feedback-link');
    await expect(link).toHaveAttribute('href', '/feedback');
    await expect(link).toBeVisible();
  });

  test('main landmark exists', async ({ page }) => {
    const main = page.locator('main.dropzone-screen');
    await expect(main).toBeVisible();
  });
});

test.describe('Skip navigation', () => {
  test('skip-nav link becomes visible on focus', async ({ page }) => {
    // Suppress the first-visit coach mark on the drop screen — it auto-
    // focuses its "Next" button ~100ms after mount, which would steal focus
    // during the test and cause :focus to bounce off skip-nav immediately.
    await page.addInitScript(() => {
      try {
        localStorage.setItem('ih_walkthrough', JSON.stringify({ drop: Date.now() }));
      } catch {}
    });
    await page.goto('/');
    // Wait for the initial history.pushState() in ScreenRouter to settle —
    // it happens synchronously inside React's mount effect and can destroy
    // the execution context of any .evaluate() that races with it.
    await page.waitForLoadState('networkidle');
    // Also wait for the skip-nav to actually exist in the DOM.
    await page.waitForFunction(() => !!document.querySelector('.skip-nav'));

    // Hidden by default — sits at top: -100% until :focus repositions it.
    const topBefore = await page.evaluate(() => {
      const el = document.querySelector('.skip-nav');
      return getComputedStyle(el).top;
    });
    expect(topBefore).not.toBe('8px');

    const href = await page.evaluate(() => document.querySelector('.skip-nav').getAttribute('href'));
    expect(href).toBe('#main-content');

    // Focus the link and read its computed `top` inside the same evaluate
    // so nothing can steal focus between the two steps. The CSS contract is
    //   .skip-nav        { top: -100%; }
    //   .skip-nav:focus  { top: 8px; }
    // so a successful focus flips `top` to exactly "8px".
    const topAfterFocus = await page.evaluate(() => {
      const el = document.querySelector('.skip-nav');
      el.focus();
      return getComputedStyle(el).top;
    });
    expect(topAfterFocus).toBe('8px');
  });
});

test.describe('Theme toggle', () => {
  test('toggles between light and dark theme', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByRole('button', { name: /switch to .+ mode/i });
    await expect(toggle).toBeVisible();

    // Wait for ThemeToggle's mount effect to stamp data-theme onto <html>.
    // Reading via page.evaluate avoids a Playwright quirk where passing a
    // possibly-null getAttribute result back into toHaveAttribute crashes
    // internally when the value is still racing with React's first effect.
    await page.waitForFunction(() => {
      const t = document.documentElement.getAttribute('data-theme');
      return t === 'light' || t === 'dark';
    });
    const initial = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(initial).toMatch(/^(light|dark)$/);

    // Click toggle — must flip to the opposite theme
    await toggle.click();
    const expectedAfter = initial === 'dark' ? 'light' : 'dark';
    await page.waitForFunction(
      (v) => document.documentElement.getAttribute('data-theme') === v,
      expectedAfter
    );

    // Click again to restore
    await toggle.click();
    await page.waitForFunction(
      (v) => document.documentElement.getAttribute('data-theme') === v,
      initial
    );
  });
});

test.describe('Image upload', () => {
  test('uploading an image transitions to mask editor', async ({ page }) => {
    // Suppress the first-visit coach mark so it doesn't overlay the file
    // input or race with the post-upload modal. Also block the native
    // `beforeinstallprompt` event — the inline script in index.html captures
    // it into window.__pwaInstallPrompt, and InstallPrompt's second useEffect
    // re-opens the modal whenever that global is set, regardless of the
    // localStorage dismissal flag. We intercept addEventListener BEFORE any
    // page scripts run so the inline capture never sees the event.
    await page.addInitScript(() => {
      try {
        localStorage.setItem('ih_walkthrough', JSON.stringify({ drop: Date.now() }));
        localStorage.setItem('install_prompt_dismissed', String(Date.now()));
      } catch {}
      const origAdd = window.addEventListener.bind(window);
      window.addEventListener = function (type, ...rest) {
        if (type === 'beforeinstallprompt') return;
        return origAdd(type, ...rest);
      };
      // Lock the global so any stray assignment is a no-op.
      try {
        Object.defineProperty(window, '__pwaInstallPrompt', {
          get() { return null; },
          set() {},
          configurable: false,
        });
      } catch {}
    });
    await page.goto('/');
    // Wait for the DropZone to be fully mounted before touching the file
    // input — `setInputFiles` races against React's first render under
    // parallel workers and can fire the change event on a detached node,
    // which lands silently inside a `handleFile` whose captured state no
    // longer matches the live component.
    await expect(page.locator('.dropzone-target')).toBeVisible();
    await page.waitForLoadState('networkidle');

    // Create a minimal 2x2 PNG test image
    const pngBuffer = createMinimalPNG();
    const pngBase64 = pngBuffer.toString('base64');

    // Dispatch the file directly via the DOM instead of Playwright's
    // `setInputFiles`. The native `input.files = dt.files` path plus a
    // React-compatible bubbling `change` event reliably reaches the
    // onChange handler even under parallel execution, where
    // `setInputFiles` has shown races with React's mount effects.
    await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], 'test.png', { type: 'image/png' });
      const input = document.querySelector('input[type="file"]:not([capture])');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, pngBase64);

    // ResolutionTierModal now intercepts every upload — click its primary
    // button to commit the default tier and kick off the pipeline.
    const confirm = page.getByRole('button', { name: 'Use this resolution' });
    await expect(confirm).toBeVisible({ timeout: ACTION_TIMEOUT_MS });
    await confirm.click();

    // Should transition away from drop zone — mask editor loads
    await expect(page.locator('.dropzone-screen')).not.toBeVisible({ timeout: ACTION_TIMEOUT_MS });
  });
});

test.describe('PWA', () => {
  test('manifest is accessible', async ({ page }) => {
    const res = await page.goto('/manifest.json');
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.name).toBeTruthy();
    expect(json.icons).toBeTruthy();
  });

  test('service worker file is accessible', async ({ page }) => {
    const res = await page.goto('/sw.js');
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('addEventListener');
  });

  test('meta tags are present', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', /.+/);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.json');
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /.+/);
  });
});

/**
 * Create a minimal valid 2x2 PNG buffer for testing.
 *
 * Uses Node's built-in zlib for IDAT compression instead of a hand-rolled
 * stored-block deflate — the hand-rolled version produced a buffer Chromium
 * would not decode, which caused `readImageSize()` in DropZone to return null
 * and silently skip the ResolutionTierModal path.
 */
function createMinimalPNG() {
  const header = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  // IHDR chunk: 2x2, 8-bit RGB
  const ihdr = createChunk('IHDR', [
    0, 0, 0, 2,  // width = 2
    0, 0, 0, 2,  // height = 2
    8,            // bit depth
    2,            // color type (RGB)
    0, 0, 0,     // compression, filter, interlace
  ]);
  // Raw scanlines: each row is `filter_byte, R,G,B, R,G,B` = 7 bytes.
  const raw = Buffer.from([
    0, 255, 0, 0, 255, 0, 0,  // row 1: filter=0, red, red
    0, 255, 0, 0, 255, 0, 0,  // row 2: filter=0, red, red
  ]);
  const zlibData = Array.from(zlib.deflateSync(raw));
  const idat = createChunk('IDAT', zlibData);
  const iend = createChunk('IEND', []);

  return Buffer.from([...header, ...ihdr, ...idat, ...iend]);
}

function createChunk(type, data) {
  const len = [
    (data.length >> 24) & 0xFF,
    (data.length >> 16) & 0xFF,
    (data.length >> 8) & 0xFF,
    data.length & 0xFF,
  ];
  const typeBytes = [...type].map(c => c.charCodeAt(0));
  const crcInput = [...typeBytes, ...data];
  const crc = crc32(crcInput);
  return [...len, ...typeBytes, ...data, ...crc];
}

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  crc ^= 0xFFFFFFFF;
  return [
    (crc >> 24) & 0xFF,
    (crc >> 16) & 0xFF,
    (crc >> 8) & 0xFF,
    crc & 0xFF,
  ];
}
