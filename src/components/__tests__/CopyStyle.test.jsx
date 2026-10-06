// @vitest-environment jsdom
// A user called the site "AI slop", citing the em dashes in the FAQ. Site copy
// should read as plainly written: no em dashes in what we write ourselves.
// Julia's article text (src/content/guides/*.md) is hers and is not checked.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { render, cleanup } from '@testing-library/react';

vi.mock('../ScreenShell', () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock('../../utils/platform', () => ({ isNativeApp: () => false, getMaxWorkingDimension: () => 4096, getNativePlatform: () => null }));
vi.mock('../../utils/analytics', () => ({ track: () => {} }));
const metas = [];
vi.mock('../../hooks/useDocumentMeta', () => ({ useDocumentMeta: (m) => { metas.push(m); } }));

import FaqScreen from '../FaqScreen';
import LandingScreen from '../LandingScreen';
import PrivacyScreen from '../PrivacyScreen';
import TermsScreen from '../TermsScreen';
import { GUIDES, GUIDES_INDEX } from '../../content/guides';

afterEach(() => { cleanup(); metas.length = 0; });
const DASH = /\u2014/;

describe('no em dashes in the copy we write', () => {
  const SCREENS = {
    FAQ: <FaqScreen onBack={() => {}} />,
    homepage: <LandingScreen onEnter={() => {}} />,
    Privacy: <PrivacyScreen onBack={() => {}} />,
    Terms: <TermsScreen onBack={() => {}} />,
  };

  it.each(Object.keys(SCREENS))('%s: page text, structured data, title and description', (name) => {
    const { container } = render(SCREENS[name]);
    expect(container.textContent, name).not.toMatch(DASH);
    container.querySelectorAll('script[type="application/ld+json"]').forEach((s) => expect(s.textContent).not.toMatch(DASH));
    metas.forEach((m) => { expect(m.title || '').not.toMatch(DASH); expect(m.description || '').not.toMatch(DASH); });
  });

  it('guide and tool page titles, descriptions and summaries', () => {
    for (const g of [...GUIDES, GUIDES_INDEX]) {
      for (const k of ['title', 'description', 'summary', 'navLabel', 'indexTitle', 'heading', 'intro']) expect(g[k] || '', `${g.route} ${k}`).not.toMatch(DASH);
    }
  });

  it('the site-wide title and description in index.html', () => {
    const html = readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
    expect(html.match(/<title>([^<]*)<\/title>/)[1]).not.toMatch(DASH);
    for (const m of html.matchAll(/<meta[^>]+content="([^"]*)"/g)) expect(m[1]).not.toMatch(DASH);
  });
});
