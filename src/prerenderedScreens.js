import { lazyWithPreload } from './utils/lazyWithPreload';

// The routes scripts/prerender.mjs turns into static HTML. Preloadable so
// main.jsx can load the route's chunk before mounting, and React's first
// commit is the same content instead of a blank Suspense fallback.
export const LandingScreen = lazyWithPreload(() => import('./components/LandingScreen'));
export const FaqScreen = lazyWithPreload(() => import('./components/FaqScreen'));
export const PrivacyScreen = lazyWithPreload(() => import('./components/PrivacyScreen'));
export const TermsScreen = lazyWithPreload(() => import('./components/TermsScreen'));

const BY_ROUTE = { '/': LandingScreen, '/faq': FaqScreen, '/privacy': PrivacyScreen, '/terms': TermsScreen };

/** Load the screen for a prerendered route; resolves at once for any other path. */
export function preloadPrerenderedRoute(route) {
  const screen = BY_ROUTE[route];
  return screen ? screen.preload() : Promise.resolve();
}
