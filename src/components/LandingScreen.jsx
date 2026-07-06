import { useEffect, useState } from 'react';
import { STICKER_PATHS } from '../utils/stickerPaths';
import { track } from '../utils/analytics';
import '../styles/Landing.css';

// Self-hosted demo video, an H.264 MP4 transcoded from the source screen
// recording (portrait 1080x2340, scaled to 720w). While VIDEO_SRC is null the
// section renders an intentional placeholder instead of a broken <video>.
const VIDEO_SRC = '/demo.mp4';
const VIDEO_POSTER = '/demo-poster.jpg';

// A few real redaction-sticker silhouettes, reused from the editor, as the
// hero/feature visual motif. The marketing art IS the product.
function StickerGlyph({ name, className }) {
  const s = STICKER_PATHS[name];
  if (!s) return null;
  return (
    <svg className={className} viewBox={`0 0 ${s.vw} ${s.vh}`} aria-hidden="true" preserveAspectRatio="none">
      <path d={s.d} fillRule="evenodd" />
    </svg>
  );
}

const FEATURES = [
  {
    title: 'Private by design',
    body: 'Face blur, stickers, and metadata stripping run entirely in your browser. Your photos never leave your device.',
    icon: (
      <path d="M12 2.5l7 3v5.5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V5.5l7-3z" />
    ),
  },
  {
    title: 'Auto face detection',
    body: 'On-device AI finds every face in your photo so you can hide them all in a single tap.',
    icon: (
      <>
        <circle cx="12" cy="12" r="3.2" />
        <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      </>
    ),
  },
  {
    title: 'Redaction stickers',
    body: 'Go beyond the black bar with brush strokes, ink rollers, marker scribbles, and matte censor bars, in any color.',
    stickers: ['brush', 'matte-censor', 'marker-scribble'],
  },
  {
    title: 'Strip location & metadata',
    body: 'Remove GPS coordinates, device details, and timestamps hidden in your photos before you post.',
    icon: (
      <>
        <path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z" />
        <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
      </>
    ),
  },
  {
    title: 'AI tattoo removal',
    body: 'Paint over an identifying tattoo and let AI rebuild the skin underneath. Free users get 3 per week, plus more by watching ads; unlimited with Premium.',
    premium: true,
    icon: (
      <path d="M4 17.5L14.5 7l2.5 2.5L6.5 20H4v-2.5zM13 5.5L15.5 3 21 8.5 18.5 11z" />
    ),
  },
  {
    title: 'Batch mode',
    body: 'Redact an entire camera roll at once, with one consistent set of settings.',
    icon: (
      <>
        <rect x="3" y="3" width="13" height="13" rx="2" />
        <path d="M8 19.5h11A1.5 1.5 0 0 0 20.5 18V7" />
      </>
    ),
  },
];

// Factual product guarantees, presented as a stat strip. No invented user
// counts or ratings; every figure here is verifiable product behavior.
const PROOF = [
  { stat: '100%', label: 'of core redaction runs on your device, never on a server' },
  { stat: '0', label: 'uploads needed for face blur, stickers, and metadata stripping' },
  { stat: '$0', label: 'for unlimited face blur, stickers, and metadata stripping' },
];

const STEPS = [
  { n: '1', title: 'Upload', body: 'Drop in a photo. It opens directly in your browser, with no upload and no account.' },
  { n: '2', title: 'Redact', body: 'Auto-detect faces, paint freehand, or place a sticker. Metadata is stripped in the same pass.' },
  { n: '3', title: 'Export', body: 'Save the clean, redacted image. The original, and everything hidden in it, stays with you.' },
];

const USE_CASES = [
  {
    title: 'Selling online',
    body: 'List items without leaking where you live. Strip GPS data and blur anything that gives your home away.',
    icon: (
      <>
        <path d="M20.6 13.3l-7.3 7.3a1.5 1.5 0 0 1-2.1 0l-7.8-7.8V3.5h9.3l7.9 7.7a1.5 1.5 0 0 1 0 2.1z" />
        <circle cx="8" cy="8" r="1.6" />
      </>
    ),
  },
  {
    title: 'Family photos',
    body: 'Share the moment without sharing your kids’ faces. One tap blurs every face in the shot.',
    icon: (
      <path d="M12 20.5s-7.5-4.7-7.5-10A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7.5 3.5c0 5.3-7.5 10-7.5 10z" />
    ),
  },
  {
    title: 'Anonymous creators',
    body: 'Post as your handle, not your legal identity. Hide faces and identifying tattoos before publishing.',
    icon: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1" />
      </>
    ),
  },
  {
    title: 'Everyday sharing',
    body: 'Protect bystanders in group shots, crowds, and street photos before they go public.',
    icon: (
      <>
        <circle cx="9" cy="8.5" r="3" />
        <path d="M3.5 19.5c0-3 2.5-4.8 5.5-4.8s5.5 1.8 5.5 4.8M15.5 6a3 3 0 0 1 0 5M17.5 14.9c1.8.6 3 1.9 3 3.9" />
      </>
    ),
  },
];

const FAQS = [
  {
    q: 'Is it really private?',
    a: 'Yes. Face blur, stickers, and metadata stripping all run inside your browser, and your photos are never uploaded. The one exception is AI tattoo removal, which uses a secure processing server.',
  },
  {
    q: 'Does it work offline?',
    a: 'Once installed, core redaction works with no connection at all. Only tattoo removal and subscriptions need the internet.',
  },
  {
    q: 'Is it free?',
    a: 'Yes. Face blur, redaction stickers, and metadata stripping are free and unlimited. AI tattoo removal is a premium feature, but free users get 3 removals per week, plus more by watching ads.',
  },
  {
    q: 'Which platforms can I use it on?',
    a: 'Any modern browser today, and you can install it as an app on Android, iOS, Windows, and Mac. The Android app is now on Google Play, with the App Store version coming soon.',
  },
];

const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.redactid.app';

function StoreBadge({ store }) {
  const isPlay = store === 'play';
  // The Android app is live on Google Play; the App Store version is still
  // in progress, so its badge stays a non-interactive "coming soon" chip.
  const live = isPlay;
  const inner = (
    <>
      <span className="landing-badge-icon" aria-hidden="true">
        {isPlay ? (
          <svg viewBox="0 0 24 24" width="22" height="22"><path d="M3.6 2.4a1 1 0 0 0-.3.7v17.8a1 1 0 0 0 .3.7l.1.1L13.5 12 3.7 2.3l-.1.1z" fill="#34a853"/><path d="M17 15.4l-3.5-3.4 3.5-3.5 4.1 2.3c1.1.6 1.1 1.7 0 2.3L17 15.4z" fill="#fbbc04"/><path d="M3.7 21.7l9.8-9.7 3.5 3.4-11.2 6.4a1 1 0 0 1-1.1 0l-1-.1z" fill="#ea4335"/><path d="M3.7 2.3l9.8 9.7L17 8.5 5.8 2.1a1 1 0 0 0-1.1-.1l-1 .3z" fill="#4285f4"/></svg>
        ) : (
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M16.4 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9s-1.8-.8-3-.8c-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7 2-1.1 2.8-2.2c.9-1.3 1.2-2.5 1.3-2.6-.1 0-2.5-1-2.5-3.8zM14.2 5.4c.6-.8 1-1.9.9-3-.9 0-2 .6-2.7 1.4-.6.7-1.1 1.8-.9 2.9 1 .1 2-.5 2.7-1.3z"/></svg>
        )}
      </span>
      <span className="landing-badge-text">
        <span className="landing-badge-sub">{live ? 'Get it on' : 'Coming soon to'}</span>
        <span className="landing-badge-store">{isPlay ? 'Google Play' : 'App Store'}</span>
      </span>
    </>
  );
  if (live) {
    return (
      <a
        className="landing-badge landing-badge-live"
        href={PLAY_STORE_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Get Redact.ID on Google Play"
        onClick={() => { try { track('landing_store_click', { store: 'play' }); } catch { /* non-blocking */ } }}
      >
        {inner}
      </a>
    );
  }
  return (
    <div className="landing-badge" aria-label="App Store, coming soon">
      {inner}
    </div>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="4 12.5 9.5 18 20 6.5" />
    </svg>
  );
}

// Centered eyebrow + heading + optional subtitle used by every section, so
// the page reads with one consistent typographic rhythm.
function SectionHead({ eyebrow, title, sub }) {
  return (
    <div className="landing-section-head landing-reveal">
      <span className="landing-eyebrow">{eyebrow}</span>
      <h2 className="landing-h2">{title}</h2>
      {sub && <p className="landing-section-sub">{sub}</p>}
    </div>
  );
}

export default function LandingScreen({ onEnter }) {
  const [openFaq, setOpenFaq] = useState(null);

  useEffect(() => {
    try { track('landing_view'); } catch { /* non-blocking */ }
  }, []);

  // Scroll-reveal: sections and cards carry .landing-reveal and get
  // .is-visible added the first time they enter the viewport. Under
  // prefers-reduced-motion everything is shown immediately (the CSS also
  // neutralizes the transform/transition as a second layer of defense).
  useEffect(() => {
    const els = Array.from(document.querySelectorAll('.landing-reveal'));
    if (typeof IntersectionObserver === 'undefined'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      els.forEach((el) => el.classList.add('is-visible'));
      return undefined;
    }
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('is-visible');
          obs.unobserve(e.target);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, []);

  const enter = (source) => {
    try { track('landing_enter', { source }); } catch { /* non-blocking */ }
    onEnter?.();
  };

  const handleInstall = () => {
    try { track('landing_install_click'); } catch { /* non-blocking */ }
    const p = typeof window !== 'undefined' ? window.__pwaInstallPrompt : null;
    if (p && p.prompt) {
      p.prompt();
      try { p.userChoice?.finally?.(() => { window.__pwaInstallPrompt = null; }); } catch { /* ignore */ }
    } else {
      // No native install prompt (iOS Safari, already installed, or
      // unsupported), so just drop them into the tool.
      enter('install-fallback');
    }
  };

  const year = new Date().getFullYear();

  return (
    <div className="landing">
      <header className="landing-nav">
        <a className="landing-brand" href="#top" aria-label="Redact.ID home">
          <img className="landing-brand-icon" src="/icons/icon-512.png" alt="" aria-hidden="true" width="30" height="30" />
          Redact<span className="landing-brand-dot">.ID</span>
        </a>
        <nav className="landing-nav-links">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#faq">FAQ</a>
          <button className="landing-btn landing-btn-ghost" onClick={() => enter('nav')}>Open app</button>
        </nav>
      </header>

      <main id="top">
        {/* Hero */}
        <section className="landing-hero">
          <div className="landing-hero-glow" aria-hidden="true" />
          <div className="landing-hero-inner landing-reveal">
            <img className="landing-hero-logo" src="/icons/icon-512.png" alt="Redact.ID" width="78" height="78" />
            <span className="landing-eyebrow landing-hero-eyebrow">Private photo redaction</span>
            <h1 className="landing-hero-title">
              Share photos without revealing <span className="landing-accent">who you are</span>.
            </h1>
            <p className="landing-hero-sub">
              Blur faces, place censor stickers, and strip hidden location data in seconds.
              Core redaction runs entirely on your device, so your photos stay yours.
            </p>
            <div className="landing-cta-row">
              <button className="landing-btn landing-btn-primary" onClick={() => enter('hero')}>
                Try it free
              </button>
              <button className="landing-btn landing-btn-secondary" onClick={handleInstall}>
                Install app
              </button>
            </div>
            <ul className="landing-hero-points" aria-label="Key guarantees">
              <li><CheckIcon /> No account needed</li>
              <li><CheckIcon /> Free core tools</li>
              <li><CheckIcon /> Works offline once installed</li>
            </ul>
            <div className="landing-badges">
              <StoreBadge store="play" />
              <StoreBadge store="apple" />
            </div>
          </div>
          <div className="landing-hero-media landing-reveal" aria-label="Product demo">
            <div className="landing-video">
              {VIDEO_SRC ? (
                <video
                  className="landing-video-el"
                  src={VIDEO_SRC}
                  poster={VIDEO_POSTER || undefined}
                  controls
                  playsInline
                  preload="metadata"
                />
              ) : (
                <div className="landing-video-placeholder">
                  <span className="landing-video-play" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor"><path d="M8 5.5v13l11-6.5z" /></svg>
                  </span>
                  <span className="landing-video-caption">30-second demo</span>
                </div>
              )}
            </div>
            <span className="landing-video-note">30-second demo, recorded in the real app</span>
          </div>
        </section>

        {/* Proof strip: factual guarantees, no invented numbers */}
        <section className="landing-proof-wrap" aria-label="Privacy guarantees">
          <div className="landing-proof landing-reveal">
            {PROOF.map((p) => (
              <div className="landing-proof-item" key={p.stat}>
                <span className="landing-proof-stat">{p.stat}</span>
                <span className="landing-proof-label">{p.label}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Features */}
        <section className="landing-section" id="features">
          <SectionHead
            eyebrow="Toolkit"
            title="Everything you need to disappear from a photo"
            sub="Six tools, one pass, and nothing to configure."
          />
          <div className="landing-grid">
            {FEATURES.map((f, i) => (
              <div className="landing-card landing-reveal" style={{ '--reveal-delay': `${(i % 3) * 70}ms` }} key={f.title}>
                <div className="landing-card-icon" aria-hidden="true">
                  {f.stickers ? (
                    <div className="landing-card-stickers">
                      {f.stickers.map((s) => <StickerGlyph key={s} name={s} className="landing-card-sticker" />)}
                    </div>
                  ) : (
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      {f.icon}
                    </svg>
                  )}
                </div>
                <h3 className="landing-card-title">
                  {f.title}
                  {f.premium && <span className="landing-tag">Premium</span>}
                </h3>
                <p className="landing-card-body">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section className="landing-section landing-how" id="how">
          <SectionHead
            eyebrow="Workflow"
            title="Three steps. Zero uploads."
            sub="From camera roll to clean image in under a minute."
          />
          <div className="landing-steps">
            {STEPS.map((s, i) => (
              <div className="landing-step landing-reveal" style={{ '--reveal-delay': `${i * 90}ms` }} key={s.n}>
                <div className="landing-step-n">{s.n}</div>
                <h3 className="landing-step-title">{s.title}</h3>
                <p className="landing-step-body">{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Use cases */}
        <section className="landing-section landing-uses-section">
          <SectionHead
            eyebrow="Use cases"
            title="Built for real life"
            sub="Wherever a photo says more than you meant to share."
          />
          <div className="landing-uses">
            {USE_CASES.map((u, i) => (
              <div className="landing-use landing-reveal" style={{ '--reveal-delay': `${(i % 2) * 70}ms` }} key={u.title}>
                <div className="landing-use-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    {u.icon}
                  </svg>
                </div>
                <div className="landing-use-text">
                  <h3 className="landing-use-title">{u.title}</h3>
                  <p className="landing-use-body">{u.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* CTA band */}
        <section className="landing-band landing-reveal">
          <h2 className="landing-band-title">Ready to redact?</h2>
          <p className="landing-band-sub">Free, private, and works right in your browser.</p>
          <div className="landing-cta-row landing-cta-center">
            <button className="landing-btn landing-btn-primary" onClick={() => enter('band')}>
              Try it free
            </button>
            <button className="landing-btn landing-btn-secondary" onClick={handleInstall}>
              Install app
            </button>
          </div>
          <div className="landing-badges landing-badges-center">
            <StoreBadge store="play" />
            <StoreBadge store="apple" />
          </div>
        </section>

        {/* FAQ */}
        <section className="landing-section" id="faq">
          <SectionHead eyebrow="FAQ" title="Questions, answered" />
          <div className="landing-faq landing-reveal">
            {FAQS.map((item, i) => {
              const open = openFaq === i;
              return (
                <div className={`landing-faq-item${open ? ' is-open' : ''}`} key={item.q}>
                  <button
                    className="landing-faq-q"
                    aria-expanded={open}
                    onClick={() => setOpenFaq(open ? null : i)}
                  >
                    <span>{item.q}</span>
                    <svg className="landing-faq-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
                  </button>
                  {open && <p className="landing-faq-a">{item.a}</p>}
                </div>
              );
            })}
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <a className="landing-brand landing-brand-sm" href="#top">
            <img className="landing-brand-icon" src="/icons/icon-512.png" alt="" aria-hidden="true" width="26" height="26" />
            Redact<span className="landing-brand-dot">.ID</span>
          </a>
          <nav className="landing-footer-links">
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href="/faq">FAQ</a>
            <a href="/feedback">Feedback</a>
          </nav>
          <span className="landing-footer-copy">&copy; {year} Redact.ID</span>
        </div>
      </footer>
    </div>
  );
}
