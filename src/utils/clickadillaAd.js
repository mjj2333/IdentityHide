/**
 * Clickadilla video ad integration.
 *
 * Preloads the VAST data + video when the editor mounts, then plays
 * instantly when the user hits Apply. One ad per image.
 *
 * To disable:  set CLICKADILLA_ENABLED = false.
 * To remove:   delete this file and remove the calls in
 *              MaskEditorScreen.jsx.
 */

// ── Feature flag ──────────────────────────────────────────────
export const CLICKADILLA_ENABLED = true;

// ── Ad pool state ────────────────────────────────────────────
// Hybrid pool: up to MAX_PRELOAD_RETRIES attempts fire on editor mount, each
// success adds an entry (deduped by videoUrl). Only the first few entries
// pre-buffer video bytes — rest are metadata-only to avoid memory pressure
// on mobile. On Apply we pick a random entry (preferring buffered).
let adPool = [];
const MAX_BUFFERED_ADS = 3;

// ── Logging ──────────────────────────────────────────────────
// `debugLog` always writes to console (cheap, useful in DevTools/Eruda).
// The visible on-screen panel is opt-in via ?panel=1 (sessionStorage
// flag `ih_debug_panel`) — kept separate from ?debug=1 / `ih_debug`
// which only loads Eruda. Default is console-only, no DOM overlay.
let debugPanel = null;
function debugLog(...args) {
  const msg = args
    .map(a => {
      if (a == null) return String(a);
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(' ');
  try { console.log(msg); } catch {}
  try {
    if (typeof sessionStorage === 'undefined') return;
    if (sessionStorage.getItem('ih_debug_panel') !== '1') return;
  } catch { return; }
  if (typeof document === 'undefined' || !document.body) return;
  if (!debugPanel) {
    debugPanel = document.createElement('div');
    debugPanel.id = 'ih-debug-panel';
    debugPanel.style.cssText = 'position:fixed;bottom:0;left:0;right:0;max-height:25vh;overflow-y:auto;background:rgba(0,0,0,0.88);color:#0f0;font-family:ui-monospace,Menlo,monospace;font-size:10px;line-height:1.3;padding:4px 6px;z-index:999999;pointer-events:none;white-space:pre-wrap;word-break:break-all;';
    document.body.appendChild(debugPanel);
  }
  const line = document.createElement('div');
  const ts = new Date().toISOString().slice(11, 19);
  line.textContent = `${ts}  ${msg}`;
  debugPanel.appendChild(line);
  while (debugPanel.children.length > 30) debugPanel.removeChild(debugPanel.firstChild);
  debugPanel.scrollTop = debugPanel.scrollHeight;
}

/**
 * Pick a video URL the browser can play from allMediaFiles.
 * Prefers MP4 (universal), falls back to anything canPlayType() accepts.
 */
function pickCompatibleVideo(data) {
  const files = data.allMediaFiles || [];
  if (files.length === 0) {
    debugLog(`[ClickadillaAd] pick: no allMediaFiles, fallback videoUrl=${data.videoUrl ? 'present' : 'null'}`);
    return data.videoUrl || null;
  }

  const probe = document.createElement('video');

  const sorted = [...files].sort((a, b) => {
    const aMP4 = a.type.includes('mp4') ? 1 : 0;
    const bMP4 = b.type.includes('mp4') ? 1 : 0;
    if (aMP4 !== bMP4) return bMP4 - aMP4;
    return (b.width || 0) - (a.width || 0);
  });

  const summary = sorted
    .map(mf => `${mf.type || '?'}@${mf.width}x${mf.height}:canPlay=${probe.canPlayType(mf.type || '') || 'no'}`)
    .join(' | ');
  debugLog(`[ClickadillaAd] pick: ${sorted.length} files [${summary}]`);

  for (const mf of sorted) {
    const support = probe.canPlayType(mf.type);
    if (support === 'probably' || support === 'maybe') {
      debugLog(`[ClickadillaAd] pick: chose ${mf.type} @ ${mf.width}x${mf.height}`);
      return mf.url;
    }
  }

  debugLog(`[ClickadillaAd] pick: no compatible codec, fallback videoUrl=${data.videoUrl ? 'present' : 'null'}`);
  return data.videoUrl || null;
}

// Preload happens in the background while the user paints, so we can afford
// many retries here. Fallback runs after Apply and blocks user progress, so
// we keep it short. Each attempt is capped at FETCH_TIMEOUT_MS so a hung
// connection can't stall the whole retry chain (seen on mobile where the
// browser held some fetches open indefinitely without resolving).
const MAX_PRELOAD_RETRIES = 10;
const MAX_FALLBACK_RETRIES = 3;
const FETCH_TIMEOUT_MS = 20000;

/**
 * Single vast-proxy attempt. Returns the parsed ad data on success, null on
 * any failure (timeout, non-2xx, or no compatible video in the response).
 * No retry logic here — callers drive the retry shape they want.
 */
async function fetchOneAd(attempt, maxAttempts) {
  debugLog(`[ClickadillaAd] fetch attempt ${attempt}/${maxAttempts}`);
  let res;
  try {
    res = await fetch('/.netlify/functions/vast-proxy', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    debugLog(`[ClickadillaAd] fetch attempt ${attempt} failed:`, err?.name || err?.message || err);
    return null;
  }
  if (!res.ok) {
    debugLog(`[ClickadillaAd] fetch attempt ${attempt} got status ${res.status}`);
    return null;
  }
  const data = await res.json();
  debugLog(`[ClickadillaAd] attempt ${attempt} response: mediaFiles=${data.allMediaFiles?.length || 0} depth=${data.depth} error=${data.error || 'none'}`);
  const videoUrl = pickCompatibleVideo(data);
  if (!videoUrl) {
    debugLog(`[ClickadillaAd] fetch attempt ${attempt} no fill / no compatible video`);
    return null;
  }
  debugLog(`[ClickadillaAd] fetch attempt ${attempt} got playable video`);
  return { ...data, videoUrl };
}

/**
 * Sequentially fire up to maxAttempts, return the first successful ad.
 * Used by the fallback path when the pool is empty at Apply time.
 */
async function fetchFirstSuccess(maxAttempts) {
  for (let i = 1; i <= maxAttempts; i++) {
    const data = await fetchOneAd(i, maxAttempts);
    if (data) return data;
  }
  return null;
}

/**
 * Buffer a successful ad into the pool. The first MAX_BUFFERED_ADS entries
 * get a fully-buffered <video> element (instant play on Apply); rest are
 * stored as metadata only and require a short buffer wait when chosen.
 */
function addToPool(data) {
  const bufferedCount = adPool.filter(e => e.video).length;
  const shouldBuffer = bufferedCount < MAX_BUFFERED_ADS;

  let video = null;
  if (shouldBuffer) {
    video = document.createElement('video');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.playsInline = true;
    video.preload = 'auto';
    video.muted = true;
    video.src = data.videoUrl;
    video.addEventListener('error', () => {
      // Drop this entry from the pool entirely if the buffered video errors.
      debugLog('[ClickadillaAd] pool: video errored, removing from pool');
      adPool = adPool.filter(e => e.video !== video);
    });
  }

  adPool.push({
    videoUrl: data.videoUrl,
    video,
    clickThrough: data.clickThrough,
    clickTracking: data.clickTracking || [],
    trackingEvents: data.trackingEvents || {},
    impressions: data.impressions || [],
  });
  debugLog(`[ClickadillaAd] pool: added (buffered=${!!video}, size=${adPool.length})`);
}

/**
 * Run up to maxAttempts, adding each successful (and previously unseen) ad
 * to the pool. Continues after successes — unlike fetchFirstSuccess, this
 * tries every attempt even once one has succeeded, to build variety.
 */
async function fillPool(maxAttempts) {
  const seen = new Set();
  for (let i = 1; i <= maxAttempts; i++) {
    const data = await fetchOneAd(i, maxAttempts);
    if (!data) continue;
    if (seen.has(data.videoUrl)) {
      debugLog(`[ClickadillaAd] pool: dedup, attempt ${i} returned duplicate`);
      continue;
    }
    seen.add(data.videoUrl);
    addToPool(data);
  }
  debugLog(`[ClickadillaAd] pool complete: ${adPool.length} unique ads, ${adPool.filter(e => e.video).length} buffered`);
}

/**
 * Preload ads — call when the editor mounts. Kicks off up to
 * MAX_PRELOAD_RETRIES attempts sequentially in the background to build the
 * pool. Each success is added (deduped). Runs regardless of how many ads
 * we already have, to maximize variety within the retry budget.
 */
export function preloadAd() {
  if (!CLICKADILLA_ENABLED) return;
  debugLog('[ClickadillaAd] preload: starting pool build');

  // Discard any previous pool's buffered video bytes before overwriting
  for (const entry of adPool) {
    if (entry.video) {
      entry.video.removeAttribute('src');
      entry.video.load();
    }
  }
  adPool = [];

  fillPool(MAX_PRELOAD_RETRIES).catch((err) => {
    debugLog('[ClickadillaAd] preload: pool fill errored', err?.message || err);
  });
}

/**
 * Show the preloaded ad. Call on Apply.
 * If no ad is preloaded, fetches one on the fly (slower fallback).
 */
export function showClickadillaInterstitial() {
  if (!CLICKADILLA_ENABLED) {
    debugLog('[ClickadillaAd] show: CLICKADILLA_ENABLED=false, skipping');
    return Promise.resolve();
  }

  if (adPool.length > 0) {
    // Prefer a buffered ad (instant play) over a metadata-only one (short
    // buffer wait). If any buffered exists, pick from just those; otherwise
    // fall back to the full pool.
    const buffered = adPool.filter(e => e.video);
    const pickFrom = buffered.length > 0 ? buffered : adPool;
    const chosen = pickFrom[Math.floor(Math.random() * pickFrom.length)];
    adPool = adPool.filter(e => e !== chosen);

    debugLog(`[ClickadillaAd] show: picked from pool (buffered=${!!chosen.video}, remaining=${adPool.length})`);
    chosen.impressions.forEach(firePixel);

    if (chosen.video) {
      showVideoOverlay(chosen.video, chosen.clickThrough, chosen.clickTracking, chosen.trackingEvents);
    } else {
      showVideoOverlayFromUrl(chosen.videoUrl, chosen.clickThrough, chosen.clickTracking, chosen.trackingEvents);
    }
    return Promise.resolve();
  }

  debugLog('[ClickadillaAd] show: pool empty, falling back to on-the-fly fetch');
  // Fallback: no ads in pool (preload may still be running or all failed).
  // User is waiting on this so keep the retry cap short.
  fetchFirstSuccess(MAX_FALLBACK_RETRIES)
    .then(data => {
      if (!data) {
        debugLog('[ClickadillaAd] show: fallback got no fill');
        return;
      }
      debugLog('[ClickadillaAd] show: fallback got video URL', data.videoUrl);
      (data.impressions || []).forEach(firePixel);
      showVideoOverlayFromUrl(data.videoUrl, data.clickThrough, data.clickTracking || [], data.trackingEvents || {});
    })
    .catch((err) => {
      debugLog('[ClickadillaAd] show: fallback error', err?.message || err);
    });

  return Promise.resolve();
}

// Validate scheme before firing — pixel URLs come from the VAST chain,
// where a compromised or adversarial wrapper could supply data:, javascript:,
// or relative URLs. Browsers no-op most exotic schemes in <img src>, but
// gate explicitly so defense-in-depth survives future browser changes and
// so the pixel never hits our own origin (a relative path like "/admin"
// would otherwise resolve to identity-hide.com).
function firePixel(url) {
  if (!isSafeHttpUrl(url)) return;
  new Image().src = url;
}

function fireTrackingEvent(trackingEvents, eventName) {
  const urls = trackingEvents[eventName];
  if (!urls || urls.length === 0) return;
  urls.forEach(url => firePixel(url));
}

/**
 * Show overlay using a pre-buffered video element.
 */
function showVideoOverlay(video, clickThrough, clickTracking, trackingEvents) {
  const overlay = createOverlay();
  const videoWrap = createVideoWrap();

  video.muted = false;
  video.autoplay = false;
  Object.assign(video.style, {
    width: '100%',
    maxHeight: '70vh',
    background: '#000',
    borderRadius: '8px',
  });

  if (clickThrough) buildClickOverlay(videoWrap, clickThrough, clickTracking);

  const { closeOverlay } = wireEvents(video, overlay, trackingEvents);

  videoWrap.appendChild(video);
  overlay.appendChild(videoWrap);
  document.body.appendChild(overlay);

  debugLog('[ClickadillaAd] overlay: appended, attempting play()');
  video.play()
    .then(() => debugLog('[ClickadillaAd] overlay: unmuted play() succeeded'))
    .catch((err) => {
      debugLog('[ClickadillaAd] overlay: unmuted play() rejected', err?.message || err);
      video.muted = true;
      video.play()
        .then(() => debugLog('[ClickadillaAd] overlay: muted play() succeeded'))
        .catch((err2) => {
          debugLog('[ClickadillaAd] overlay: muted play() also rejected, closing', err2?.message || err2);
          closeOverlay();
        });
    });
}

/**
 * Show overlay by creating a fresh video element (fallback path).
 */
function showVideoOverlayFromUrl(videoUrl, clickThrough, clickTracking, trackingEvents) {
  const overlay = createOverlay();
  const videoWrap = createVideoWrap();

  const video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.playsInline = true;
  video.autoplay = true;
  video.muted = false;
  video.src = videoUrl;
  Object.assign(video.style, {
    width: '100%',
    maxHeight: '70vh',
    background: '#000',
    borderRadius: '8px',
  });

  if (clickThrough) buildClickOverlay(videoWrap, clickThrough, clickTracking);

  const { closeOverlay } = wireEvents(video, overlay, trackingEvents);

  videoWrap.appendChild(video);
  overlay.appendChild(videoWrap);
  document.body.appendChild(overlay);

  debugLog('[ClickadillaAd] overlay: appended, attempting play()');
  video.play()
    .then(() => debugLog('[ClickadillaAd] overlay: unmuted play() succeeded'))
    .catch((err) => {
      debugLog('[ClickadillaAd] overlay: unmuted play() rejected', err?.message || err);
      video.muted = true;
      video.play()
        .then(() => debugLog('[ClickadillaAd] overlay: muted play() succeeded'))
        .catch((err2) => {
          debugLog('[ClickadillaAd] overlay: muted play() also rejected, closing', err2?.message || err2);
          closeOverlay();
        });
    });
}

// ── Shared UI helpers ────────────────────────────────────────

function createOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'clickadilla-overlay';
  Object.assign(overlay.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '100vw',
    height: '100vh',
    zIndex: '90000',
    background: 'rgba(0,0,0,0.92)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    opacity: '0',
    transition: 'opacity 0.15s',
  });
  return overlay;
}

function createVideoWrap() {
  const videoWrap = document.createElement('div');
  Object.assign(videoWrap.style, {
    position: 'relative',
    width: '100%',
    maxWidth: '640px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  });
  return videoWrap;
}

// Only http(s) URLs are allowed for the clickThrough anchor — a malicious or
// malformed VAST response could supply javascript:/data:/vbscript: URIs which
// would execute in the page context when the user clicks the ad.
function isSafeHttpUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function buildClickOverlay(videoWrap, clickThrough, clickTracking) {
  if (!isSafeHttpUrl(clickThrough)) {
    // Skip the overlay entirely — ad still plays, impression still fires, but
    // there's nothing clickable pointing at an unsafe URL.
    return;
  }
  const clickOverlay = document.createElement('a');
  clickOverlay.href = clickThrough;
  clickOverlay.target = '_blank';
  clickOverlay.rel = 'noopener noreferrer';
  Object.assign(clickOverlay.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    width: '100%',
    height: '100%',
    zIndex: '1',
    cursor: 'pointer',
  });
  clickOverlay.addEventListener('click', () => {
    clickTracking.forEach(url => firePixel(url));
  });
  videoWrap.appendChild(clickOverlay);

  const learnMore = document.createElement('div');
  Object.assign(learnMore.style, {
    position: 'absolute',
    bottom: '8px',
    left: '8px',
    padding: '4px 10px',
    fontSize: '11px',
    color: 'rgba(255,255,255,0.8)',
    background: 'rgba(0,0,0,0.6)',
    borderRadius: '4px',
    pointerEvents: 'none',
    zIndex: '2',
  });
  learnMore.textContent = 'Learn More';
  videoWrap.appendChild(learnMore);
}

function wireEvents(video, overlay, trackingEvents) {
  const firedEvents = new Set();
  const fireOnce = (eventName) => {
    if (firedEvents.has(eventName)) return;
    firedEvents.add(eventName);
    fireTrackingEvent(trackingEvents, eventName);
  };

  const onTimeUpdate = () => {
    if (!video.duration) return;
    const pct = video.currentTime / video.duration;
    if (video.currentTime > 0 && !firedEvents.has('start')) {
      fireOnce('start');
      fireOnce('creativeView');
    }
    if (pct >= 0.25) fireOnce('firstQuartile');
    if (pct >= 0.50) fireOnce('midpoint');
    if (pct >= 0.75) fireOnce('thirdQuartile');
  };

  let closed = false;
  const closeOverlay = () => {
    if (closed) return;
    closed = true;
    video.removeEventListener('ended', onEnded);
    video.removeEventListener('error', onError);
    video.removeEventListener('timeupdate', onTimeUpdate);
    video.removeEventListener('pause', onPause);
    video.removeEventListener('playing', onPlaying);
    video.pause();
    video.removeAttribute('src');
    overlay.remove();
  };

  const onEnded = () => {
    fireOnce('complete');
    closeOverlay();
  };
  const onError = () => {
    closeOverlay();
  };
  const onPause = () => {
    if (!closed) fireTrackingEvent(trackingEvents, 'pause');
  };
  const onPlaying = () => {
    overlay.style.opacity = '1';
    if (firedEvents.has('start')) fireTrackingEvent(trackingEvents, 'resume');
  };

  video.addEventListener('ended', onEnded);
  video.addEventListener('error', onError);
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('pause', onPause);
  video.addEventListener('playing', onPlaying);

  return { closeOverlay };
}
