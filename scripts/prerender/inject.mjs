// Pure HTML surgery for the prerender step (scripts/prerender.mjs): takes the
// built SPA shell (dist/index.html) and what a headless browser captured for
// one route, and returns that route's static page. Kept free of I/O so it is
// unit-testable (scripts/__tests__/prerenderInject.test.js).

// Runs inline, straight after #root, before first paint. The prerendered file
// can be served where it doesn't apply: Netlify's SPA fallback serves
// index.html (= the prerendered landing) for /account, /success…; the service
// worker's offline fallback serves whatever page it cached last; and the app
// skips the landing for installed PWAs, native shells, returning visitors in
// this tab and post-checkout returns (?session_id…). In all those cases the
// markup is wrong for what React is about to render, so drop it and let the
// app start from an empty root exactly as before prerendering existed. Mirrors
// `showLandingInitially` in src/App.jsx — keep the two in sync.
export const GUARD_SCRIPT = '<script>(function(){try{'
  + 'var r=document.getElementById("root");var p=r&&r.getAttribute("data-prerendered");if(!p)return;'
  + 'var here=location.pathname;while(here.length>1&&here.charAt(here.length-1)==="/")here=here.slice(0,-1);var keep=here===p;'
  + 'if(keep&&p==="/"){'
  + 'var nat=!!(window.Capacitor&&window.Capacitor.isNativePlatform&&window.Capacitor.isNativePlatform());'
  + 'var mm=function(q){try{return !!(window.matchMedia&&window.matchMedia(q).matches)}catch(e){return false}};'
  + 'var sa=mm("(display-mode: standalone)")||mm("(display-mode: fullscreen)")||window.navigator.standalone===true;'
  + 'var ent=false;try{ent=sessionStorage.getItem("redact_entered")==="1"}catch(e){}'
  + 'keep=!location.search&&!nat&&!sa&&!ent;}'
  + 'if(!keep){r.innerHTML="";r.removeAttribute("data-prerendered");}'
  + '}catch(e){}})();</script>';

const escapeAttr = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function setMeta(html, attr, key, value) {
  if (!value) return html;
  const re = new RegExp(`<meta ${attr}="${key}" content="[^"]*"\\s*/?>`);
  const tag = `<meta ${attr}="${key}" content="${escapeAttr(value)}" />`;
  return re.test(html) ? html.replace(re, tag) : html.replace('</head>', `    ${tag}\n  </head>`);
}

/**
 * @param {string} shell  dist/index.html as built by Vite (must contain an empty #root)
 * @param {{route:string, rootHtml:string, title?:string, description?:string,
 *          canonical?:string, stylesheets?:string[], modulepreloads?:string[]}} page
 */
export function injectPrerender(shell, page) {
  const EMPTY_ROOT = '<div id="root"></div>';
  if (!shell.includes(EMPTY_ROOT)) throw new Error('shell has no empty <div id="root"></div> — already prerendered?');
  let html = shell;

  if (page.title) {
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeText(page.title)}</title>`);
    html = setMeta(html, 'property', 'og:title', page.title);
    html = setMeta(html, 'name', 'twitter:title', page.title);
  }
  if (page.description) {
    html = setMeta(html, 'name', 'description', page.description);
    html = setMeta(html, 'property', 'og:description', page.description);
    html = setMeta(html, 'name', 'twitter:description', page.description);
  }
  if (page.canonical) {
    html = html.replace(/<link rel="canonical" href="[^"]*"\s*\/?>/, `<link rel="canonical" href="${escapeAttr(page.canonical)}" />`);
    html = setMeta(html, 'property', 'og:url', page.canonical);
  }

  // Lazy route chunks + their CSS: CSS must be in the initial HTML or the page
  // paints unstyled; module preloads let the chunk download while the HTML is
  // already on screen.
  const extra = [];
  for (const href of page.stylesheets || []) {
    if (!html.includes(`href="${href}"`)) extra.push(`<link rel="stylesheet" crossorigin href="${href}">`);
  }
  for (const href of page.modulepreloads || []) {
    if (!html.includes(`"${href}"`)) extra.push(`<link rel="modulepreload" crossorigin href="${href}">`);
  }
  if (extra.length) html = html.replace('</head>', `    ${extra.join('\n    ')}\n  </head>`);

  return html.replace(
    EMPTY_ROOT,
    `<div id="root" data-prerendered="${escapeAttr(page.route)}">${page.rootHtml}</div>\n    ${GUARD_SCRIPT}`,
  );
}
