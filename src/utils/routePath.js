/**
 * The route the app should render for a URL path. Trailing slashes are
 * dropped because the prerendered pages live at <route>/index.html, which the
 * host also serves for "/faq/" — without this the app would not recognise it.
 * The inline guard in scripts/prerender/inject.mjs normalises the same way.
 */
export function routePath(pathname) {
  let p = pathname || '/';
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}
