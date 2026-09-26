import { describe, it, expect } from 'vitest';
import { parseGuide, parseInline, headingId } from '../guideMarkdown';

describe('parseGuide — blocks', () => {
  it('reads headings, one line per paragraph, and horizontal rules', () => {
    const { blocks } = parseGuide('# Title\n## Section\nFirst line.\nSecond line.\n---\n### Sub');
    expect(blocks).toEqual([
      { type: 'h1', text: 'Title', id: 'title' },
      { type: 'h2', text: 'Section', id: 'section' },
      { type: 'p', text: 'First line.' },
      { type: 'p', text: 'Second line.' },
      { type: 'hr' },
      { type: 'h3', text: 'Sub', id: 'sub' },
    ]);
  });

  it('keeps exactly one H1: any later "# " heading becomes an H2', () => {
    const { blocks } = parseGuide('# Main\ntext\n# Closing Call To Action');
    expect(blocks.filter((b) => b.type === 'h1')).toHaveLength(1);
    expect(blocks[2]).toEqual({ type: 'h2', text: 'Closing Call To Action', id: 'closing-call-to-action' });
  });

  it('groups bullet and numbered lists', () => {
    const { blocks } = parseGuide('- a\n- b\nafter\n1. one\n2. two');
    expect(blocks).toEqual([
      { type: 'ul', items: ['a', 'b'] },
      { type: 'p', text: 'after' },
      { type: 'ol', items: ['one', 'two'] },
    ]);
  });

  it('joins a line ending in " \\" with the next one (a line break inside one paragraph)', () => {
    const { blocks } = parseGuide('**Tattoo Removal** \\\nRemove identifying tattoos.');
    expect(blocks).toEqual([{ type: 'p', text: '**Tattoo Removal**', lines: ['**Tattoo Removal**', 'Remove identifying tattoos.'] }]);
  });

  it('reads images, before/after pairs and buttons', () => {
    const { blocks } = parseGuide([
      '::image /guides/a.webp | An app screenshot',
      '::pair /guides/b.webp | Before photo || /guides/c.webp | After photo',
      '::button Blur a Face | /?from=face-blur-app',
      '::link Learn About Tattoo Removal | /tattoo-removal-app',
    ].join('\n'));
    expect(blocks).toEqual([
      { type: 'image', src: '/guides/a.webp', alt: 'An app screenshot' },
      { type: 'pair', before: { src: '/guides/b.webp', alt: 'Before photo' }, after: { src: '/guides/c.webp', alt: 'After photo' } },
      { type: 'button', label: 'Blur a Face', href: '/?from=face-blur-app', primary: true },
      { type: 'button', label: 'Learn About Tattoo Removal', href: '/tattoo-removal-app', primary: false },
    ]);
  });
});

describe('parseGuide — FAQ', () => {
  const md = [
    '## Why',
    'intro',
    '## Frequently Asked Questions',
    '### What is EXIF data?',
    'EXIF is **metadata**.',
    'It can hold [location](/remove-exif-data).',
    '### Is it free?',
    '- Yes',
    '- Always',
    '---',
    '## After the FAQ',
    'not part of any answer',
  ].join('\n');

  it('collects each question under a "Frequently Asked Questions" heading with its answer as plain text', () => {
    const { faq } = parseGuide(md);
    expect(faq).toEqual([
      { q: 'What is EXIF data?', a: 'EXIF is metadata. It can hold location.' },
      { q: 'Is it free?', a: 'Yes. Always.' },
    ]);
  });

  it('has no FAQ when the page has no FAQ heading', () => {
    expect(parseGuide('## Why\n### Q?\nA.').faq).toEqual([]);
  });
});

describe('parseInline', () => {
  it('splits bold and links into segments', () => {
    expect(parseInline('Read **our guide** or [the FAQ](/faq).')).toEqual([
      { t: 'text', v: 'Read ' },
      { t: 'bold', v: 'our guide' },
      { t: 'text', v: ' or ' },
      { t: 'link', v: 'the FAQ', href: '/faq' },
      { t: 'text', v: '.' },
    ]);
  });

  it('allows a link inside bold text', () => {
    expect(parseInline('**[protecting your identity](/post-photos-anonymously)**')).toEqual([
      { t: 'bold', v: [{ t: 'link', v: 'protecting your identity', href: '/post-photos-anonymously' }] },
    ]);
  });
});

describe('headingId', () => {
  it('makes a stable anchor from heading text', () => {
    expect(headingId('A Quick Privacy Checklist Before Posting')).toBe('a-quick-privacy-checklist-before-posting');
    expect(headingId('1. Blur Your Face')).toBe('1-blur-your-face');
    expect(headingId('What’s Behind You?')).toBe('whats-behind-you');
  });
});
