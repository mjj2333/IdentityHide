// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { render, cleanup } from '@testing-library/react';
import { GUIDES, GUIDE_ROUTES, getGuide } from '../index';
import { IMAGE_SIZES } from '../imageSizes';
import { parseGuide } from '../../../utils/guideMarkdown';
import { GUIDE_ROUTES as APP_GUIDE_ROUTES } from '../../../prerenderedScreens';

vi.mock('../../../components/ScreenShell', () => ({ default: ({ children }) => <div>{children}</div> }));
import GuidePage from '../../../components/GuidePage';

afterEach(() => cleanup());

const APP_ROUTES = new Set(['/', '/faq', '/privacy', '/terms', ...GUIDE_ROUTES]);

describe('guide content', () => {
  it('has the four pages written for search, each with its own URL', () => {
    expect(GUIDE_ROUTES).toEqual(['/face-blur-app', '/remove-exif-data', '/tattoo-removal-app', '/post-photos-anonymously']);
  });

  it("keeps the app shell's route list (kept separate to stay out of the main bundle) in step with the registry", () => {
    expect(APP_GUIDE_ROUTES).toEqual(GUIDE_ROUTES);
  });

  it('lists every guide in the sitemap and the prerender step', () => {
    const sitemap = readFileSync(path.join(process.cwd(), 'public/sitemap.xml'), 'utf8');
    const prerender = readFileSync(path.join(process.cwd(), 'scripts/prerender.mjs'), 'utf8');
    for (const r of GUIDE_ROUTES) {
      expect(sitemap).toContain(`<loc>https://redactid.app${r}</loc>`);
      expect(prerender).toContain(`route: '${r}'`);
    }
  });

  it.each(GUIDES.map((g) => [g.route, g]))('%s has one H1, a 30–65 char title and a 120–165 char description', (route, g) => {
    const { blocks } = parseGuide(g.markdown);
    expect(blocks.filter((b) => b.type === 'h1')).toHaveLength(1);
    expect(blocks[0].type).toBe('h1');
    expect(g.title.length).toBeGreaterThanOrEqual(30);
    expect(g.title.length).toBeLessThanOrEqual(65);
    expect(g.description.length).toBeGreaterThanOrEqual(120);
    expect(g.description.length).toBeLessThanOrEqual(165);
  });

  it.each(GUIDES.map((g) => [g.route, g]))('%s only links to pages that exist and images that are in public/guides', (route, g) => {
    const { blocks } = parseGuide(g.markdown);
    const hrefs = [];
    const srcs = [];
    for (const b of blocks) {
      const text = [b.text, ...(b.lines || []), ...(b.items || [])].filter(Boolean).join(' ');
      for (const m of text.matchAll(/\]\(([^)]+)\)/g)) hrefs.push(m[1]);
      if (b.type === 'button') hrefs.push(b.href);
      if (b.type === 'image') srcs.push(b.src);
      if (b.type === 'pair') srcs.push(b.before.src, b.after.src);
    }
    for (const href of hrefs) {
      const pathOnly = href.split('#')[0].split('?')[0] || '/';
      expect(APP_ROUTES.has(pathOnly), `${route} links to ${href}`).toBe(true);
    }
    for (const src of srcs) {
      expect(existsSync(path.join(process.cwd(), 'public', src)), `${route} uses missing ${src}`).toBe(true);
      expect(IMAGE_SIZES[src], `${src} has no recorded size`).toBeTruthy();
    }
  });
});

describe('GuidePage', () => {
  it('renders the page with a single H1, sized images and working calls to action', () => {
    const { container } = render(<GuidePage route="/tattoo-removal-app" />);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('h1').textContent).toBe('Tattoo Removal App');
    const imgs = [...container.querySelectorAll('img')];
    expect(imgs.length).toBeGreaterThan(3);
    imgs.forEach((img) => {
      expect(img.getAttribute('alt')).toBeTruthy();
      expect(img.getAttribute('width')).toBeTruthy();
      expect(img.getAttribute('height')).toBeTruthy();
    });
    const toTool = [...container.querySelectorAll('a')].filter((a) => a.getAttribute('href') === '/?from=tattoo-removal-app');
    expect(toTool.length).toBeGreaterThan(0);
  });

  it('emits FAQPage structured data matching the visible questions', () => {
    const { container } = render(<GuidePage route="/remove-exif-data" />);
    const ld = JSON.parse(container.querySelector('script[type="application/ld+json"]').textContent);
    expect(ld['@type']).toBe('FAQPage');
    expect(ld.mainEntity[0]).toMatchObject({ '@type': 'Question', name: 'What is EXIF data?' });
    expect(ld.mainEntity[0].acceptedAnswer.text).toMatch(/^EXIF is metadata/);
    const visible = [...container.querySelectorAll('h3')].map((h) => h.textContent);
    ld.mainEntity.forEach((q) => expect(visible).toContain(q.name));
  });

  it('links to the other guides so every page is reachable from every other', () => {
    const { container } = render(<GuidePage route="/face-blur-app" />);
    const nav = container.querySelector('nav[aria-label="More photo privacy guides"]');
    const links = [...nav.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(expect.arrayContaining(['/remove-exif-data', '/tattoo-removal-app', '/post-photos-anonymously']));
    expect(links).not.toContain('/face-blur-app');
  });

  it('gives headings anchors, so the privacy checklist can be linked to directly', () => {
    const { container } = render(<GuidePage route="/post-photos-anonymously" />);
    expect(container.querySelector('#a-quick-privacy-checklist-before-posting')).toBeTruthy();
  });

  it('knows every route it is asked for', () => {
    GUIDE_ROUTES.forEach((r) => expect(getGuide(r)).toBeTruthy());
    expect(getGuide('/nope')).toBeNull();
  });
});
