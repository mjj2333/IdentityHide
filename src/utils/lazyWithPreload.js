import { lazy, createElement } from 'react';

/**
 * React.lazy with a `preload()` that, once resolved, lets the component render
 * synchronously — no Suspense fallback on the first commit.
 *
 * Used for the prerendered routes (/, /faq, /privacy, /terms): main.jsx awaits
 * the route's preload before mounting, so React replaces the prerendered HTML
 * with identical markup instead of blanking it to the `fallback={null}` while
 * the chunk downloads.
 */
export function lazyWithPreload(factory) {
  let Loaded = null;
  let pending = null;
  const load = () => {
    if (!pending) pending = factory().then((mod) => { Loaded = mod.default; return mod; });
    return pending;
  };
  const Lazy = lazy(load);
  function Preloadable(props) {
    return createElement(Loaded || Lazy, props);
  }
  Preloadable.preload = load;
  return Preloadable;
}
