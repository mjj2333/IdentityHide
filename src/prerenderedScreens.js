import { lazyWithPreload } from './utils/lazyWithPreload';

// The routes scripts/prerender.mjs turns into static HTML. Preloadable so
// main.jsx can load the route's chunk before mounting, and React's first
// commit is the same content instead of a blank Suspense fallback.
export const LandingScreen = lazyWithPreload(() => import('./components/LandingScreen'));
export const FaqScreen = lazyWithPreload(() => import('./components/FaqScreen'));
export const PrivacyScreen = lazyWithPreload(() => import('./components/PrivacyScreen'));
export const TermsScreen = lazyWithPreload(() => import('./components/TermsScreen'));
export const GuidePage = lazyWithPreload(() => import('./components/GuidePage'));

// The SEO content pages (src/content/guides). Listed here rather than
// imported from the registry so the markdown stays out of the main bundle.
export const GUIDE_ROUTES = ['/face-blur-app', '/remove-exif-data', '/tattoo-removal-app', '/post-photos-anonymously'];

const BY_ROUTE = { '/': LandingScreen, '/faq': FaqScreen, '/privacy': PrivacyScreen, '/terms': TermsScreen };

/** Load the screen for a prerendered route; resolves at once for any other path. */
export function preloadPrerenderedRoute(route) {
  const screen = BY_ROUTE[route] || (GUIDE_ROUTES.includes(route) ? GuidePage : null);
  return screen ? screen.preload() : Promise.resolve();
}
