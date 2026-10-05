// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { render, cleanup } from '@testing-library/react';
import { GUIDES, GUIDES_INDEX } from '../index';

vi.mock('../../../components/ScreenShell', () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock('../../../utils/analytics', () => ({ track: () => {} }));
import GuidesIndexPage from '../../../components/GuidesIndexPage';
import LandingScreen from '../../../components/LandingScreen';

afterEach(() => cleanup());
const read = (p) => readFileSync(path.join(process.cwd(), p), 'utf8');

describe('guides index (/guides)', () => {
  it('every page is filed as a how-to guide or a tool, with a one-line summary', () => {
    GUIDES.forEach((g) => {
      expect(['guide', 'tool']).toContain(g.kind);
      expect(g.summary.length).toBeGreaterThan(40);
    });
    expect(GUIDES.filter((g) => g.kind === 'guide').map((g) => g.route)).toEqual(['/post-photos-anonymously']);
    expect(GUIDES.filter((g) => g.kind === 'tool').map((g) => g.route)).toEqual(['/face-blur-app', '/remove-exif-data', '/tattoo-removal-app']);
  });

  it('lists the how-to articles first, then the tools, each linked with its summary', () => {
    const { container } = render(<GuidesIndexPage />);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    const sections = [...container.querySelectorAll('section')];
    expect(sections.map((s) => s.querySelector('h2').textContent)).toEqual(['Guides', 'Tools']);
    const links = (s) => [...s.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links(sections[0])).toEqual(['/post-photos-anonymously']);
    expect(links(sections[1])).toEqual(['/face-blur-app', '/remove-exif-data', '/tattoo-removal-app']);
    GUIDES.forEach((g) => expect(container.textContent).toContain(g.summary));
  });

  it('has its own search title and description', () => {
    expect(GUIDES_INDEX.route).toBe('/guides');
    expect(GUIDES_INDEX.title.length).toBeGreaterThanOrEqual(30);
    expect(GUIDES_INDEX.title.length).toBeLessThanOrEqual(65);
    expect(GUIDES_INDEX.description.length).toBeGreaterThanOrEqual(120);
    expect(GUIDES_INDEX.description.length).toBeLessThanOrEqual(165);
  });

  it('is prerendered and in the sitemap', () => {
    expect(read('scripts/prerender.mjs')).toContain("route: '/guides'");
    expect(read('public/sitemap.xml')).toContain('<loc>https://redactid.app/guides</loc>');
  });
});

describe('where Guides is linked', () => {
  it('homepage footer: one Guides link, no separate tool or article links (they are on the Guides page)', () => {
    const { container } = render(<LandingScreen onEnter={() => {}} />);
    const hrefs = [...container.querySelectorAll('.landing-footer-links a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/guides');
    for (const r of ['/face-blur-app', '/remove-exif-data', '/tattoo-removal-app', '/post-photos-anonymously']) expect(hrefs).not.toContain(r);
  });

  it('homepage feature cards link to their tool pages, keeping those one click from the homepage', () => {
    const { container } = render(<LandingScreen onEnter={() => {}} />);
    const cardLink = (title) => [...container.querySelectorAll('.landing-card')]
      .find((c) => c.querySelector('.landing-card-title').textContent.startsWith(title))
      ?.querySelector('a.landing-card-link')?.getAttribute('href');
    expect(cardLink('Auto face detection')).toBe('/face-blur-app');
    expect(cardLink('Strip location & metadata')).toBe('/remove-exif-data');
    expect(cardLink('AI tattoo removal')).toBe('/tattoo-removal-app');
    expect(cardLink('Batch mode')).toBeUndefined();
    container.querySelectorAll('a.landing-card-link').forEach((a) => expect(a.getAttribute('aria-label')).toMatch(/^Learn more about /));
  });

  it('is NOT linked from the app start screen (homepage only, for now)', () => {
    expect(read('src/components/DropZone.jsx')).not.toContain('/guides');
  });
});
