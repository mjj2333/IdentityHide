import ScreenShell from './ScreenShell';
import { useDocumentMeta } from '../hooks/useDocumentMeta';
import { GUIDES, GUIDES_INDEX } from '../content/guides';
import '../styles/GuidePage.css';

const SITE = 'https://redactid.app';

function Entries({ kind }) {
  return (
    <ul className="guide-index-list">
      {GUIDES.filter((g) => g.kind === kind).map((g) => (
        <li key={g.route}>
          <a href={g.route}>{g.indexTitle || g.navLabel}</a>
          <p>{g.summary}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * /guides — the hub for the content pages: how-to articles, then the tool
 * pages. Linked from the homepage footer (not from inside the app).
 */
export default function GuidesIndexPage({ onBack }) {
  useDocumentMeta({
    title: GUIDES_INDEX.title,
    description: GUIDES_INDEX.description,
    canonical: SITE + GUIDES_INDEX.route,
    ogImage: `${SITE}/og-image.png`,
  });
  return (
    <ScreenShell backAction={onBack} backLabel="Home">
      <article className="guide-container">
        <h1 className="guide-title">{GUIDES_INDEX.heading}</h1>
        <p>{GUIDES_INDEX.intro}</p>
        <section>
          <h2>Guides</h2>
          <Entries kind="guide" />
        </section>
        <section>
          <h2>Tools</h2>
          <Entries kind="tool" />
        </section>
      </article>
    </ScreenShell>
  );
}
