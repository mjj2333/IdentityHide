/**
 * Tiny Markdown dialect for the SEO content pages (src/content/guides/*.md).
 * The copy is written in Google Docs and pasted in as-is, so the rules follow
 * how those docs are laid out rather than full CommonMark:
 *
 *   # / ## / ###      headings (only the first "# " stays an H1 — one per page)
 *   one line          one paragraph
 *   "text \" + line   a line break inside the same paragraph
 *   - item / 1. item  lists
 *   ---               divider
 *   ::image src | alt
 *   ::pair src | alt || src | alt       before/after pair
 *   ::button Label | href               primary call to action
 *   ::link Label | href                 secondary call to action
 *   **bold**, [text](href)              inline
 *
 * A "## Frequently Asked Questions" section turns its "### question" blocks
 * and their answers into `faq`, used for the FAQPage structured data.
 */

export function headingId(text) {
  return String(text)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseInline(text) {
  const out = [];
  const re = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
    if (m[1] !== undefined) {
      const inner = parseInline(m[1]);
      out.push({ t: 'bold', v: inner.length === 1 && inner[0].t === 'text' ? inner[0].v : inner });
    } else {
      out.push({ t: 'link', v: m[2], href: m[3] });
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

function plainText(text) {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

const splitPair = (s) => {
  const [src, ...alt] = s.split('|');
  return { src: src.trim(), alt: alt.join('|').trim() };
};

export function parseGuide(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let sawH1 = false;
  let list = null;

  const closeList = () => { if (list) { blocks.push(list); list = null; } };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) { closeList(); continue; }

    const bullet = /^-\s+(.*)$/.exec(line);
    const numbered = /^\d+\.\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const type = bullet ? 'ul' : 'ol';
      if (!list || list.type !== type) { closeList(); list = { type, items: [] }; }
      list.items.push((bullet || numbered)[1]);
      continue;
    }
    closeList();

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      let level = heading[1].length;
      if (level === 1) { if (sawH1) level = 2; sawH1 = true; }
      const text = heading[2].trim();
      blocks.push({ type: `h${level}`, text, id: headingId(text) });
      continue;
    }
    if (line === '---') { blocks.push({ type: 'hr' }); continue; }

    const directive = /^::(image|pair|button|link)\s+(.*)$/.exec(line);
    if (directive) {
      const [, kind, rest] = directive;
      if (kind === 'image') blocks.push({ type: 'image', ...splitPair(rest) });
      else if (kind === 'pair') {
        const [a, b] = rest.split('||');
        blocks.push({ type: 'pair', before: splitPair(a), after: splitPair(b) });
      } else {
        const { src: label, alt: href } = splitPair(rest);
        blocks.push({ type: 'button', label, href, primary: kind === 'button' });
      }
      continue;
    }

    // Paragraph, possibly continued onto following lines with a trailing " \".
    const parts = [];
    while (line.endsWith('\\')) {
      parts.push(line.slice(0, -1).trim());
      i++;
      line = (lines[i] || '').trim();
    }
    if (parts.length) {
      parts.push(line);
      blocks.push({ type: 'p', text: parts[0], lines: parts });
    } else {
      blocks.push({ type: 'p', text: line });
    }
  }
  closeList();

  // FAQ: questions (h3) under an h2 "Frequently Asked Questions", until the
  // next h2 or divider.
  const faq = [];
  let inFaq = false;
  let current = null;
  const answerText = (b) => {
    if (b.type === 'p') return plainText((b.lines || [b.text]).join(' '));
    if (b.type === 'ul' || b.type === 'ol') return b.items.map((it) => plainText(it).replace(/[.]?$/, '.')).join(' ');
    return '';
  };
  for (const b of blocks) {
    if (b.type === 'h2' || b.type === 'h1' || b.type === 'hr') {
      if (current) { faq.push(current); current = null; }
      inFaq = b.type === 'h2' && /frequently asked questions/i.test(b.text);
      continue;
    }
    if (!inFaq) continue;
    if (b.type === 'h3') {
      if (current) faq.push(current);
      current = { q: b.text, a: '' };
    } else if (current) {
      const t = answerText(b);
      if (t) current.a = current.a ? `${current.a} ${t}` : t;
    }
  }
  if (current) faq.push(current);

  return { blocks, faq };
}
