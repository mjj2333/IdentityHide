// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { injectPrerender, GUARD_SCRIPT } from '../prerender/inject.mjs';

const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <title>Redact.ID — Home Title</title>
    <meta name="description" content="Home description." />
    <meta property="og:title" content="Home OG title" />
    <meta property="og:description" content="Home OG description." />
    <meta property="og:image" content="https://redactid.app/og-image.png" />
    <meta name="twitter:title" content="Home twitter title" />
    <link rel="canonical" href="https://redactid.app/" />
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-abc.css">
  </head>
  <body style="margin:0;">
    <div id="root"></div>
    <script>var other = 1;</script>
  </body>
</html>`;

const CAPTURE = {
  route: '/faq',
  rootHtml: '<div class="faq-container"><h1 class="faq-title">FAQ</h1><p>Answer &amp; more</p></div>',
  title: 'FAQ — Redact.ID',
  description: 'Common questions about "Redact.ID".',
  canonical: 'https://redactid.app/faq',
  stylesheets: ['/assets/index-abc.css', '/assets/FaqScreen-x1.css'],
  modulepreloads: ['/assets/FaqScreen-x1.js', '/assets/index-abc.js'],
};

describe('injectPrerender', () => {
  it('puts the rendered page inside #root, tagged with its route', () => {
    const html = injectPrerender(SHELL, CAPTURE);
    expect(html).toContain('<div id="root" data-prerendered="/faq"><div class="faq-container"><h1 class="faq-title">FAQ</h1>');
    expect(html).not.toContain('<div id="root"></div>');
  });

  it("replaces the title, description, canonical and social text tags with the route's own (escaped)", () => {
    const html = injectPrerender(SHELL, CAPTURE);
    expect(html).toContain('<title>FAQ — Redact.ID</title>');
    expect(html).toContain('<meta name="description" content="Common questions about &quot;Redact.ID&quot;." />');
    expect(html).toContain('<meta property="og:title" content="FAQ — Redact.ID" />');
    expect(html).toContain('<meta property="og:description" content="Common questions about &quot;Redact.ID&quot;." />');
    expect(html).toContain('<meta name="twitter:title" content="FAQ — Redact.ID" />');
    expect(html).toContain('<link rel="canonical" href="https://redactid.app/faq" />');
    expect(html).not.toMatch(/Home (Title|description|OG|twitter)/);
  });

  it('adds only the stylesheets and module preloads the shell does not already have', () => {
    const html = injectPrerender(SHELL, CAPTURE);
    expect(html.match(/index-abc\.css/g)).toHaveLength(1);
    expect(html).toContain('<link rel="stylesheet" crossorigin href="/assets/FaqScreen-x1.css">');
    expect(html).toContain('<link rel="modulepreload" crossorigin href="/assets/FaqScreen-x1.js">');
    expect(html).not.toContain('modulepreload" crossorigin href="/assets/index-abc.js"');
    expect(html.indexOf('FaqScreen-x1.css')).toBeLessThan(html.indexOf('</head>'));
  });

  it('places the guard script right after #root so it runs before first paint', () => {
    const html = injectPrerender(SHELL, CAPTURE);
    const rootEnd = html.indexOf('</p></div></div>') + '</p></div></div>'.length;
    expect(html.slice(rootEnd).trimStart().startsWith(GUARD_SCRIPT)).toBe(true);
  });

  it('keeps everything else in the shell byte-for-byte', () => {
    const html = injectPrerender(SHELL, CAPTURE);
    expect(html).toContain('<script type="module" crossorigin src="/assets/index-abc.js"></script>');
    expect(html).toContain('<script>var other = 1;</script>');
    expect(html).toContain('<meta property="og:image" content="https://redactid.app/og-image.png" />');
  });

  it('refuses a shell without an empty #root (never double-prerender)', () => {
    const once = injectPrerender(SHELL, CAPTURE);
    expect(() => injectPrerender(once, CAPTURE)).toThrow(/root/);
  });
});

// The guard runs as inline JS in the page. Evaluate it against a jsdom
// document to check when it keeps or clears the prerendered markup.
function runGuard({ path, prerendered = '/', search = '', standalone = false, entered = false, native = false }) {
  document.body.innerHTML = `<div id="root" data-prerendered="${prerendered}"><h1>Landing</h1></div>`;
  window.history.replaceState(null, '', path + search);
  window.matchMedia = (q) => ({ matches: standalone && q.includes('standalone') });
  sessionStorage.clear();
  if (entered) sessionStorage.setItem('redact_entered', '1');
  window.Capacitor = native ? { isNativePlatform: () => true } : undefined;
  new Function(GUARD_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, ''))();
  const root = document.getElementById('root');
  return { kept: root.innerHTML !== '', attr: root.getAttribute('data-prerendered') };
}

describe('guard script', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('keeps a content page on its own path', () => {
    expect(runGuard({ path: '/faq', prerendered: '/faq' })).toEqual({ kept: true, attr: '/faq' });
  });

  it('treats a trailing slash as the same page (the host serves faq/index.html for /faq/)', () => {
    expect(runGuard({ path: '/faq/', prerendered: '/faq' })).toEqual({ kept: true, attr: '/faq' });
  });

  it('clears the markup when the file is served for a different path (SPA fallback, cached shell)', () => {
    expect(runGuard({ path: '/account', prerendered: '/' })).toEqual({ kept: false, attr: null });
    expect(runGuard({ path: '/', prerendered: '/faq' })).toEqual({ kept: false, attr: null });
  });

  it('keeps the landing for a first-time browser visitor at /', () => {
    expect(runGuard({ path: '/' }).kept).toBe(true);
  });

  it('clears the landing whenever the app would skip it', () => {
    expect(runGuard({ path: '/', entered: true }).kept).toBe(false);
    expect(runGuard({ path: '/', standalone: true }).kept).toBe(false);
    expect(runGuard({ path: '/', search: '?session_id=cs_1' }).kept).toBe(false);
    expect(runGuard({ path: '/', native: true }).kept).toBe(false);
  });
});
