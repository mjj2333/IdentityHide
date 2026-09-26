import { useEffect, useMemo } from 'react';
import ScreenShell from './ScreenShell';
import { useDocumentMeta } from '../hooks/useDocumentMeta';
import { GUIDES, getGuide } from '../content/guides';
import { IMAGE_SIZES } from '../content/guides/imageSizes';
import { parseGuide, parseInline } from '../utils/guideMarkdown';
import '../styles/GuidePage.css';

const SITE = 'https://redactid.app';

function Segments({ segs }) {
  return segs.map((seg, i) => {
    if (seg.t === 'text') return seg.v;
    if (seg.t === 'link') return <a key={i} href={seg.href}>{seg.v}</a>;
    return <strong key={i}>{typeof seg.v === 'string' ? seg.v : <Segments segs={seg.v} />}</strong>;
  });
}

const Inline = ({ text }) => <Segments segs={parseInline(text)} />;

function Img({ src, alt, eager }) {
  const [w, h] = IMAGE_SIZES[src] || [];
  return <img src={src} alt={alt} width={w} height={h} loading={eager ? 'eager' : 'lazy'} decoding="async" />;
}

function Block({ block, first }) {
  switch (block.type) {
    case 'h1': return <h1 className="guide-title">{block.text}</h1>;
    case 'h2': return <h2 id={block.id}>{block.text}</h2>;
    case 'h3': return <h3 id={block.id}>{block.text}</h3>;
    case 'hr': return <hr />;
    case 'ul': return <ul>{block.items.map((it, i) => <li key={i}><Inline text={it} /></li>)}</ul>;
    case 'ol': return <ol>{block.items.map((it, i) => <li key={i}><Inline text={it} /></li>)}</ol>;
    case 'image': return <figure className="guide-figure"><Img src={block.src} alt={block.alt} /></figure>;
    case 'pair':
      return (
        <figure className="guide-pair">
          <div><Img src={block.before.src} alt={block.before.alt} eager={first} /><figcaption>Before</figcaption></div>
          <div><Img src={block.after.src} alt={block.after.alt} eager={first} /><figcaption>After</figcaption></div>
        </figure>
      );
    case 'button':
      return (
        <p className="guide-cta">
          <a className={`btn ${block.primary ? 'btn-primary' : 'btn-secondary'} btn-lg`} href={block.href}>{block.label}</a>
        </p>
      );
    default:
      return block.lines
        ? <p>{block.lines.map((l, i) => <span key={i}>{i > 0 && <br />}<Inline text={l} /></span>)}</p>
        : <p><Inline text={block.text} /></p>;
  }
}

/**
 * One SEO content page (see src/content/guides). Real, user-facing pages —
 * people land here from search and continue into the tool via the buttons.
 */
export default function GuidePage({ route, onBack }) {
  const guide = getGuide(route);
  const { blocks, faq } = useMemo(() => parseGuide(guide?.markdown || ''), [guide]);
  useDocumentMeta({
    title: guide?.title,
    description: guide?.description,
    canonical: guide ? SITE + guide.route : undefined,
    ogImage: `${SITE}/og-image.png`,
  });
  // Links like /post-photos-anonymously#a-quick-privacy-checklist-before-posting:
  // the browser jumps to the anchor in the prerendered HTML, but mounting the
  // app replaces that page and the scroll resets, so jump again once rendered.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
  }, [route]);
  if (!guide) return null;

  const faqSchema = faq.length ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
  } : null;
  const firstPair = blocks.findIndex((b) => b.type === 'pair');

  return (
    <ScreenShell backAction={onBack} backLabel="Home">
      {faqSchema && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      )}
      <article className="guide-container">
        {blocks.map((b, i) => <Block key={i} block={b} first={i === firstPair} />)}
        <nav className="guide-related" aria-label="More photo privacy guides">
          <h2>More photo privacy guides</h2>
          <ul>
            {GUIDES.filter((g) => g.route !== route).map((g) => (
              <li key={g.route}><a href={g.route}>{g.navLabel}</a></li>
            ))}
            <li><a href="/faq">FAQ</a></li>
          </ul>
        </nav>
      </article>
    </ScreenShell>
  );
}
