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
    navLabel: 'Face blur app',
    title: 'Face Blur App — Blur Faces in Photos Automatically | Redact.ID',
    description: 'Blur faces in photos automatically, manually or with a paint-on brush. Redact.ID is a free, privacy-first face blur app — your photos stay on your device.',
    markdown: faceBlurApp,
  },
  {
    route: '/remove-exif-data',
    navLabel: 'Remove EXIF data',
    title: 'Remove EXIF Data From Photos — Free & Private | Redact.ID',
    description: 'Remove hidden EXIF metadata — GPS location, date, device and camera details — from your photos before you share them. Free, in your browser, no upload.',
    markdown: removeExifData,
  },
  {
    route: '/tattoo-removal-app',
    navLabel: 'Tattoo removal app',
    title: 'AI Tattoo Removal App — Remove Tattoos From Photos | Redact.ID',
    description: 'Remove tattoos from photos with AI. Paint over the tattoo and Redact.ID rebuilds the skin for a natural result instead of a blur. Try it free.',
    markdown: tattooRemovalApp,
  },
  {
    route: '/post-photos-anonymously',
    navLabel: 'Posting photos anonymously',
    title: 'How to Protect Your Identity in Photos Before Posting Online',
    description: 'A privacy checklist for posting photos anonymously: faces, tattoos, backgrounds, reflections, EXIF metadata and details that can link your accounts.',
    markdown: postPhotosAnonymously,
  },
];

export const GUIDE_ROUTES = GUIDES.map((g) => g.route);

export function getGuide(route) {
  return GUIDES.find((g) => g.route === route) || null;
}
