import { useEffect } from 'react';

// Updates <title>, <meta name="description">, <link rel="canonical">, and
// the og:/twitter: image tags for the current screen. SPAs render the same
// `index.html` for every route, which means every page would otherwise
// share the homepage's title, description, and social-share image — bad
// for click-through rate on subpages like /faq and /privacy.
//
// Pass undefined for any field you don't want to override, and the hook
// leaves the existing tag alone. Tags are upserted (created if missing,
// updated if present) so this works even when index.html doesn't have a
// pre-existing meta description or canonical link.
//
// `ogImage` should be an absolute URL (e.g. https://redactid.app/og/foo.png).
// Most social previewers handle relative URLs poorly and refuse to fetch.
export function useDocumentMeta({ title, description, canonical, ogImage } = {}) {
  useEffect(() => {
    if (title) {
      document.title = title;
    }
    if (description) {
      upsertMeta('name', 'description', description);
      // Keep og:description and twitter:image-side description in sync —
      // social link previewers prefer the og: tag, and falling back to a
      // home-page description on a /faq link looks unprofessional.
      upsertMeta('property', 'og:description', description);
    }
    if (title) {
      upsertMeta('property', 'og:title', title);
      upsertMeta('name', 'twitter:title', title);
    }
    if (ogImage) {
      upsertMeta('property', 'og:image', ogImage);
      upsertMeta('name', 'twitter:image', ogImage);
    }
    if (canonical) {
      let link = document.querySelector('link[rel="canonical"]');
      if (!link) {
        link = document.createElement('link');
        link.setAttribute('rel', 'canonical');
        document.head.appendChild(link);
      }
      link.setAttribute('href', canonical);
    }
  }, [title, description, canonical, ogImage]);
}

function upsertMeta(attr, value, content) {
  let tag = document.querySelector(`meta[${attr}="${value}"]`);
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute(attr, value);
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', content);
}
