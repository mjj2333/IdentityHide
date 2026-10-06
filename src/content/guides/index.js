// The SEO content pages. Copy lives in the .md files next to this (written by
// Julia in Google Drive, "Redact.ID/Website Content/Blog posts for SEO");
// rendered by components/GuidePage and prerendered to static HTML by
// scripts/prerender.mjs. Adding a page: add the .md, an entry here, the route
// to scripts/prerender.mjs ROUTES and to public/sitemap.xml.
import faceBlurApp from './face-blur-app.md?raw';
import removeExifData from './remove-exif-data.md?raw';
import tattooRemovalApp from './tattoo-removal-app.md?raw';
import postPhotosAnonymously from './post-photos-anonymously.md?raw';

export const GUIDES = [
  {
    route: '/face-blur-app',
    kind: 'tool',
    summary: 'Blur faces automatically, by hand, or with a paint-on brush, and keep your photos on your device.',
    navLabel: 'Face blur app',
    title: 'Face Blur App: Blur Faces in Photos Automatically | Redact.ID',
    description: 'Blur faces in photos automatically, manually or with a paint-on brush. Redact.ID is a free, privacy-first face blur app, and your photos stay on your device.',
    markdown: faceBlurApp,
  },
  {
    route: '/remove-exif-data',
    kind: 'tool',
    summary: 'Strip the location, date, device and camera details hidden inside a photo file before you share it.',
    navLabel: 'Remove EXIF data',
    title: 'Remove EXIF Data From Photos, Free & Private | Redact.ID',
    description: 'Remove the EXIF metadata hidden in your photos (GPS location, date, device and camera details) before you share them. Free, in your browser, no upload.',
    markdown: removeExifData,
  },
  {
    route: '/tattoo-removal-app',
    kind: 'tool',
    summary: 'Paint over a tattoo and AI rebuilds the skin underneath, for a natural result instead of a blur.',
    navLabel: 'Tattoo removal app',
    title: 'AI Tattoo Removal App: Remove Tattoos From Photos | Redact.ID',
    description: 'Remove tattoos from photos with AI. Paint over the tattoo and Redact.ID rebuilds the skin for a natural result instead of a blur. Try it free.',
    markdown: tattooRemovalApp,
  },
  {
    route: '/post-photos-anonymously',
    kind: 'guide',
    summary: 'What to check before posting a photo: faces, tattoos, backgrounds, reflections, hidden metadata, and the details that can link your accounts.',
    navLabel: 'Posting photos anonymously',
    indexTitle: 'How to protect your identity in photos before posting online',
    title: 'How to Protect Your Identity in Photos Before Posting Online',
    description: 'A privacy checklist for posting photos anonymously: faces, tattoos, backgrounds, reflections, EXIF metadata and details that can link your accounts.',
    markdown: postPhotosAnonymously,
  },
];

export const GUIDE_ROUTES = GUIDES.map((g) => g.route);

// The /guides page: how-to articles first (kind 'guide'), then the tool
// pages (kind 'tool'). A new article only needs an entry in GUIDES above.
export const GUIDES_INDEX = {
  route: '/guides',
  title: 'Photo Privacy Guides & Tools | Redact.ID',
  description: 'How-to guides for sharing photos without revealing who or where you are, plus the Redact.ID tools for blurring faces, removing tattoos and stripping metadata.',
  heading: 'Photo privacy guides',
  intro: 'Practical how-tos for sharing photos without revealing more than you mean to, and the tools that do the work.',
};

export function getGuide(route) {
  return GUIDES.find((g) => g.route === route) || null;
}
