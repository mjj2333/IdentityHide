import { useState, useId } from 'react';
import ScreenShell from './ScreenShell';
import { useDocumentMeta } from '../hooks/useDocumentMeta';

// Each entry pairs a renderable answer (`a`, can be string or JSX) with a
// plain-HTML version (`aHtml`) used by FAQPage structured data. Google
// requires the schema text to match what the user sees, so any change to
// `a` should land in `aHtml` too. For string answers we just reuse `a`
// (no need to duplicate); for JSX answers the HTML string mirrors the
// rendered markup.
const FAQ_DATA = [
  {
    category: 'App Info',
    questions: [
      {
        q: 'Where are my photos stored?',
        a: 'Face blur, mask editing, metadata stripping, and export all run entirely in your browser — nothing leaves your device. Tattoo removal is the one exception: the relevant image region is sent to our processing server, processed in memory (never written to disk), and discarded as soon as the result comes back. A temporary copy of your in-progress session is also cached locally in your browser (IndexedDB) for up to 4 hours so you can resume interrupted work. See the Privacy Policy for full detail.',
      },
      {
        q: 'How does the app use AI?',
        a: (
          <>
            <p>AI is used for two key functions:</p>
            <ul>
              <li>Face detection and blurring — runs entirely in your browser using a small on-device model</li>
              <li>Tattoo removal — the masked region of your image is sent to our processing server, where AI inpainting fills the area; the server processes it in memory and discards it immediately</li>
            </ul>
            <p>Everything else — mask editing, metadata stripping, and export — stays on your device.</p>
          </>
        ),
        aHtml: '<p>AI is used for two key functions:</p><ul><li>Face detection and blurring — runs entirely in your browser using a small on-device model</li><li>Tattoo removal — the masked region of your image is sent to our processing server, where AI inpainting fills the area; the server processes it in memory and discards it immediately</li></ul><p>Everything else — mask editing, metadata stripping, and export — stays on your device.</p>',
      },
      {
        q: 'What do I get with the premium plan? (Coming soon)',
        a: (
          <>
            <p>The premium plan includes:</p>
            <ul>
              <li>No ads</li>
              <li>Unlimited AI tattoo removal</li>
              <li>Batch processing for multiple images</li>
            </ul>
          </>
        ),
        aHtml: '<p>The premium plan includes:</p><ul><li>No ads</li><li>Unlimited AI tattoo removal</li><li>Batch processing for multiple images</li></ul>',
      },
      {
        q: 'Is AI tattoo removal free?',
        a: 'Face blur, redaction stickers, and metadata stripping are always free and unlimited. AI tattoo removal is a premium feature, but free users get 3 removals per week, plus more by watching a short ad. Premium unlocks unlimited removals with no ads.',
      },
    ],
  },
  {
    category: 'Privacy & Data Protection',
    questions: [
      {
        q: 'What is EXIF data and why should I remove it?',
        a: 'EXIF (Exchangeable Image File Format) data is hidden metadata embedded in your photos. It can include details like the date and time the photo was taken, the device used, camera settings, and sometimes even the exact GPS location. Removing EXIF data helps protect your privacy by preventing others from accessing sensitive information about where you were, when the photo was taken, and what device you used.',
      },
    ],
  },
  {
    category: 'Identity Protection',
    questions: [
      {
        q: 'Why is it important to protect your identity?',
        a: 'With the rise of AI-powered recognition tools, faces, tattoos, and even subtle physical features can be used to identify individuals. What once felt anonymous online is no longer guaranteed. Protecting your identity helps reduce the risk of being tracked, identified, or having your content linked back to you.',
      },
      {
        q: 'What is the best way to protect your identity in photos?',
        a: 'The most secure method is to completely block identifying features using solid overlays (like black bars) and compress the image. For a more natural look, strong blurring or removing defining features (such as facial details or tattoos) is effective. If a human can recognize you from the image, advanced AI likely can too.',
      },
      {
        q: 'Who benefits from this app?',
        a: (
          <>
            <p>This app is designed for anyone who values privacy, including:</p>
            <ul>
              <li>People sharing content online</li>
              <li>Professionals working under pseudonyms</li>
              <li>Anyone wanting to protect their identity</li>
              <li>Users who want to blur or protect bystanders in their photos</li>
            </ul>
          </>
        ),
        aHtml: '<p>This app is designed for anyone who values privacy, including:</p><ul><li>People sharing content online</li><li>Professionals working under pseudonyms</li><li>Anyone wanting to protect their identity</li><li>Users who want to blur or protect bystanders in their photos</li></ul>',
      },
    ],
  },
];

// FAQPage JSON-LD. Computed once at module scope from FAQ_DATA so the schema
// stays in lockstep with what's rendered. Google requires the answer text
// in the schema to match what's visible to the user — `aHtml` mirrors the
// JSX answers, and string `a` values are passed through unchanged.
const FAQ_SCHEMA = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ_DATA.flatMap((section) =>
    section.questions.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.aHtml || item.a,
      },
    }))
  ),
};

function FaqItem({ question, answer }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className={`faq-item ${open ? 'faq-item-open' : ''}`}>
      <button
        type="button"
        className="faq-question"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <span>{question}</span>
        <svg
          className="faq-chevron"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="faq-answer" id={panelId} role="region" aria-label={question}>
          {typeof answer === 'string' ? <p>{answer}</p> : answer}
        </div>
      )}
    </div>
  );
}

export default function FaqScreen({ onBack }) {
  useDocumentMeta({
    title: 'FAQ — Redact.ID',
    description: 'Common questions about Redact.ID — how face blur, tattoo removal, and metadata stripping work, what stays on your device, and how the privacy model is enforced.',
    canonical: 'https://redactid.app/faq',
    // Swap to /og/faq.png once a per-route image is designed.
    ogImage: 'https://redactid.app/og-image.png',
  });
  return (
    <ScreenShell backAction={onBack} backLabel="Back">
      {/* FAQPage structured data — only emitted on this route, where the
          questions and answers are actually visible. Google uses this to
          surface FAQ entries directly in search results as expandable
          "People Also Ask" accordions. The schema lives next to the
          rendered FAQ so the two stay in sync. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_SCHEMA) }}
      />
      <div className="faq-container">
        <h1 className="faq-title">FAQ</h1>

        {FAQ_DATA.map((section) => (
          <section key={section.category} className="faq-section">
            <h2 className="faq-category">{section.category}</h2>
            {section.questions.map((item) => (
              <FaqItem key={item.q} question={item.q} answer={item.a} />
            ))}
          </section>
        ))}
      </div>
    </ScreenShell>
  );
}
