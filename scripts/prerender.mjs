// Build-time prerender for the web build (`npm run build:web`, which Netlify
// runs). The site is a client-rendered SPA: without this every URL serves the
// same empty index.html, so search engines see the homepage's title on /faq
// and no page text until JavaScript runs. This renders each content route in
// headless Chromium against the freshly built dist/, captures what users see
// (the #root markup, the route's title/description/canonical from
// useDocumentMeta, and the lazy CSS + JS it loaded) and writes it into
// dist/<route>.html (dist/index.html for /) via ./prerender/inject.mjs.
//
// Only content routes are prerendered; the editor stays client-side. Native
// builds use plain `vite build` and never run this.
//
// Requires Playwright's Chromium on the build machine (`npx playwright install
// chromium`). SKIP_PRERENDER=1 skips it (the site still works, as a plain SPA).
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright';
import { injectPrerender } from './prerender/inject.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

// route → an element that only exists once that route's own content rendered.
const ROUTES = [
  { route: '/', ready: '.landing-hero-title' },
  { route: '/faq', ready: '.faq-title' },
  { route: '/privacy', ready: '.terms-title' },
  { route: '/terms', ready: '.terms-title' },
];

// UI that must never be baked into static HTML (per-visitor or transient).
const STRIP_SELECTORS = ['.flag-badge', '.diag-panel', '.install-prompt', '.coach-mark', '.update-prompt', '.offline-banner'];

async function main() {
  if (process.env.SKIP_PRERENDER === '1') {
    console.log('[prerender] SKIP_PRERENDER=1 — leaving dist/ as a plain SPA');
    return;
  }
  const shellPath = path.join(DIST, 'index.html');
  const shell = await readFile(shellPath, 'utf8');
  // Keep the untouched SPA shell next to the pages for reference/debugging.
  await copyFile(shellPath, path.join(DIST, 'spa-shell.html'));

  const server = await preview({ root: ROOT, preview: { port: 4179, strictPort: true, open: false }, logLevel: 'warn' });
  const origin = 'http://localhost:4179';
  const browser = await chromium.launch();
  // Capture every route BEFORE writing anything: writing / first would make
  // dist/index.html the prerendered landing, which the preview server then
  // serves (SPA fallback) while capturing the other routes.
  const captures = [];
  try {
    for (const { route, ready } of ROUTES) {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      // Same-origin only: no ads, analytics or function calls from the build.
      await page.route('**/*', (req) => {
        const url = new URL(req.request().url());
        if (url.origin !== origin || url.pathname.startsWith('/.netlify/')) return req.abort();
        return req.continue();
      });
      const scripts = new Set();
      page.on('request', (req) => {
        const u = new URL(req.url());
        if (u.origin === origin && u.pathname.startsWith('/assets/') && u.pathname.endsWith('.js')) scripts.add(u.pathname);
      });

      await page.goto(origin + route, { waitUntil: 'networkidle' });
      await page.waitForSelector(ready, { timeout: 20000 });
      await page.waitForTimeout(300);   // let useDocumentMeta's effect land

      const captured = await page.evaluate((strip) => {
        const root = document.getElementById('root');
        const clone = root.cloneNode(true);
        strip.forEach((sel) => clone.querySelectorAll(sel).forEach((el) => el.remove()));
        // Scroll-reveal state is per-viewport; let the client decide it.
        clone.querySelectorAll('.is-visible').forEach((el) => el.classList.remove('is-visible'));
        const meta = (sel) => document.querySelector(sel)?.getAttribute('content') || undefined;
        return {
          rootHtml: clone.innerHTML,
          title: document.title,
          description: meta('meta[name="description"]'),
          canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || undefined,
          stylesheets: [...document.querySelectorAll('link[rel="stylesheet"]')]
            .map((l) => l.getAttribute('href')).filter((h) => h && h.startsWith('/assets/')),
        };
      }, STRIP_SELECTORS);
      await context.close();

      if (!captured.rootHtml.trim()) throw new Error(`${route}: #root rendered empty`);
      captures.push({ route, ...captured, modulepreloads: [...scripts] });
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.httpServer.close(r));
  }

  const results = [];
  for (const page of captures) {
    // /faq -> dist/faq.html, not dist/faq/index.html: Netlify serves faq.html
    // at /faq as-is, but answers /faq with a 301 to /faq/ when a faq/ folder
    // exists, which would fight the canonical URL and sitemap (both /faq).
    const outFile = page.route === '/' ? path.join(DIST, 'index.html') : path.join(DIST, `${page.route.slice(1)}.html`);
    await mkdir(path.dirname(outFile), { recursive: true });
    await writeFile(outFile, injectPrerender(shell, page));
    results.push(`${page.route.padEnd(9)} ${String(page.rootHtml.length).padStart(7)} chars  "${page.title}"`);
  }
  console.log(`[prerender] wrote ${results.length} pages:\n  ${results.join('\n  ')}`);
}

main().catch((err) => {
  console.error('[prerender] FAILED:', err.message);
  console.error('[prerender] Fix it, or set SKIP_PRERENDER=1 to ship without prerendering.');
  process.exit(1);
});
