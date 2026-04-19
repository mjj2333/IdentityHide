/**
 * VAST proxy — follows the VAST wrapper chain server-side to avoid CORS.
 * Returns the final video URL + tracking pixels as JSON.
 *
 * Ad spot weights are loaded from Supabase (ad_config table) so they
 * can be changed from the admin dashboard without redeploying.
 */

import { createClient } from '@supabase/supabase-js';
import { checkOrigin } from './rateLimit.js';

// Fallback if Supabase is unreachable
const DEFAULT_SPOTS = [
  { spot_id: '1488087', weight: 50, label: 'mainstream' },
  { spot_id: '1488306', weight: 50, label: 'mainstream 2' },
];
const VAST_BASE = 'https://vast.yomeno.xyz/vast?spot_id=';
const MAX_DEPTH = 5;

// SSRF guard for VAST URLs. The VAST wrapper chain lets any intermediate ad
// server dictate where we fetch next, so a compromised (or attacker-owned)
// link in the chain could point at cloud-metadata endpoints or private
// ranges. We reject anything that isn't http(s) or whose hostname matches
// a known unsafe pattern. This does not defend against DNS rebinding — an
// attacker-owned public domain that resolves to a private IP at fetch time
// would still reach the private address. Closing that requires IP-pinned
// fetches; see backlog.
const DENIED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./,                      // IPv4 loopback
  /^0\./,                         // IPv4 "this host"
  /^169\.254\./,                  // AWS/GCP IMDS + link-local
  /^10\./,                        // RFC1918 private
  /^192\.168\./,                  // RFC1918 private
  /^172\.(1[6-9]|2\d|3[01])\./,   // RFC1918 private
  /^::1$/,                        // IPv6 loopback
  /^fe80:/i,                      // IPv6 link-local
  /^fc[0-9a-f]{2}:/i,             // IPv6 unique-local
  /^metadata\.google\.internal$/i,
  /\.internal$/i,                 // reserved TLD for private use
];

function isSafeVastUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  return !DENIED_HOSTNAME_PATTERNS.some(re => re.test(host));
}

let supabase;
function getClient() {
  if (!supabase) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabase;
}

async function loadSpots() {
  try {
    const { data, error } = await getClient()
      .from('ad_config')
      .select('value')
      .eq('key', 'weights')
      .single();
    if (!error && data?.value?.spots?.length > 0) return data.value.spots;
  } catch { /* fall through */ }
  return DEFAULT_SPOTS;
}

function pickWeighted(spots) {
  // Filter out weight-0 spots — admin set them to 0 intentionally.
  const active = spots.filter(s => s.weight > 0);
  if (active.length === 0) return null;
  const total = active.reduce((sum, s) => sum + s.weight, 0);
  let roll = Math.random() * total;
  for (const spot of active) {
    roll -= spot.weight;
    if (roll <= 0) return VAST_BASE + spot.spot_id;
  }
  return VAST_BASE + active[active.length - 1].spot_id;
}

export const handler = async (event) => {
  // Rate limiting was added here, then removed — the Netlify Blobs CAS
  // cycle inside rateLimit() adds seconds of latency per call, and the
  // ad-preload retry loop in clickadillaAd.js multiplies that into
  // 10-20s per editor open. checkOrigin + isSafeVastUrl (below) handle
  // the realistic abuse cases (cross-origin scanners, SSRF). If IP-level
  // rate limiting becomes necessary, add it at the Cloudflare edge
  // where it won't sit on the hot path.

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, body: '' };
  }

  // Same-origin gate — the proxy is only meant for calls from the app itself.
  // Without this, any site can embed our proxy and burn our ad-fetch budget.
  const og = checkOrigin(event);
  if (og.rejected) return og.response;

  const headers = { 'Content-Type': 'application/json' };

  // Forward real user identity so ad server sees the same IP/UA as tracking pixels.
  // Prefer Netlify's trusted header — x-forwarded-for / client-ip are forwarded
  // from the client and can be spoofed. x-nf-client-connection-ip is set by
  // Netlify's edge from the actual TCP connection. Pass through raw — ad
  // networks do per-device fraud checks that break when UA/IP are stripped
  // or even slightly normalized, so we don't sanitize here.
  const clientIp = event.headers['x-nf-client-connection-ip']
    || event.headers['client-ip']
    || event.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || '';
  const clientUa = event.headers['user-agent'] || '';

  // Load weights from Supabase (falls back to hardcoded defaults)
  const spots = await loadSpots();

  // Try weighted pick first, fall back to other active spots if it fails.
  // Spots with weight=0 are excluded from both primary selection and fallback.
  const primary = pickWeighted(spots);
  if (!primary) {
    // All spots disabled — return no-fill immediately
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ videoUrl: null, error: 'No ad fill', impressions: [], depth: 0 }),
    };
  }
  const fallbacks = spots
    .filter(s => s.weight > 0)
    .map(s => VAST_BASE + s.spot_id)
    .filter(u => u !== primary);
  const order = [primary, ...fallbacks];

  const isMobile = /Mobi|Android|iPhone|iPad/.test(clientUa);
  console.log(`[vast-proxy] handler: ${order.length} spots, mobile=${isMobile}, ua=${clientUa.slice(0, 60)}`);

  for (const vastUrl of order) {
    // Defense-in-depth: vastUrl comes from VAST_BASE + a trusted spot_id, but
    // gate it anyway so a misconfigured Supabase ad_config row can't point the
    // proxy at an unsafe endpoint.
    if (!isSafeVastUrl(vastUrl)) continue;
    const spotId = vastUrl.match(/spot_id=(\d+)/)?.[1] || '?';
    const spotStart = Date.now();
    try {
      const result = await resolveVast(vastUrl, 0, clientIp, clientUa);
      const elapsed = Date.now() - spotStart;
      if (result.videoUrl) {
        console.log(`[vast-proxy] spot ${spotId} FILLED in ${elapsed}ms, depth=${result.depth}, type=${result.type}`);
        return { statusCode: 200, headers, body: JSON.stringify(result) };
      }
      console.log(`[vast-proxy] spot ${spotId} no-fill in ${elapsed}ms, depth=${result.depth}`);
      // No fill — try next spot
    } catch (err) {
      const elapsed = Date.now() - spotStart;
      console.log(`[vast-proxy] spot ${spotId} threw after ${elapsed}ms: ${err.message}`);
      // Failed — try next spot
    }
  }
  console.log(`[vast-proxy] all spots exhausted, returning no-fill`);

  // All spots exhausted
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ videoUrl: null, error: 'No ad fill', impressions: [], depth: 0 }),
  };
};

async function resolveVast(url, depth, clientIp, clientUa) {
  if (depth > MAX_DEPTH) throw new Error('Too many VAST wrapper redirects');

  const fetchHeaders = {};
  if (clientUa) fetchHeaders['User-Agent'] = clientUa;
  if (clientIp) fetchHeaders['X-Forwarded-For'] = clientIp;

  const host = (() => { try { return new URL(url).hostname; } catch { return '?'; } })();
  const fetchStart = Date.now();
  const res = await fetch(url, { headers: fetchHeaders });
  const fetchElapsed = Date.now() - fetchStart;
  console.log(`[vast-proxy] depth=${depth} fetch ${host} -> ${res.status} in ${fetchElapsed}ms`);
  if (!res.ok) throw new Error(`VAST fetch failed: ${res.status} from ${url}`);

  const xml = await res.text();

  // Parse with regex (no DOMParser in serverless)
  // Look for MediaFile elements
  const mediaFiles = [];
  const mediaRegex = /<MediaFile[^>]*type="([^"]*)"[^>]*width="(\d+)"[^>]*height="(\d+)"[^>]*>([\s\S]*?)<\/MediaFile>/gi;
  let match;
  while ((match = mediaRegex.exec(xml)) !== null) {
    mediaFiles.push({
      type: match[1],
      width: parseInt(match[2]),
      height: parseInt(match[3]),
      url: match[4].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim(),
    });
  }

  // Also try simpler MediaFile pattern (attributes in different order)
  if (mediaFiles.length === 0) {
    const simpleRegex = /<MediaFile[^>]*>([\s\S]*?)<\/MediaFile>/gi;
    while ((match = simpleRegex.exec(xml)) !== null) {
      const tag = match[0];
      const type = tag.match(/type="([^"]*)"/)?.[1] || '';
      const width = tag.match(/width="(\d+)"/)?.[1] || '0';
      const height = tag.match(/height="(\d+)"/)?.[1] || '0';
      mediaFiles.push({
        type,
        width: parseInt(width),
        height: parseInt(height),
        url: match[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim(),
      });
    }
  }

  // Extract impression pixels
  const impressions = [];
  const impRegex = /<Impression[^>]*>([\s\S]*?)<\/Impression>/gi;
  while ((match = impRegex.exec(xml)) !== null) {
    const url = match[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    if (url) impressions.push(url);
  }

  // Extract click-through URL
  const clickMatch = xml.match(/<ClickThrough[^>]*>([\s\S]*?)<\/ClickThrough>/i);
  const clickThrough = clickMatch
    ? clickMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim()
    : null;

  // Extract click tracking URLs
  const clickTracking = [];
  const clickTrackRegex = /<ClickTracking[^>]*>([\s\S]*?)<\/ClickTracking>/gi;
  while ((match = clickTrackRegex.exec(xml)) !== null) {
    const url = match[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim();
    if (url) clickTracking.push(url);
  }

  // Extract tracking events (start, firstQuartile, midpoint, thirdQuartile, complete, etc.)
  const trackingEvents = {};
  const trackRegex = /<Tracking[^>]*event="([^"]*)"[^>]*>([\s\S]*?)<\/Tracking>/gi;
  while ((match = trackRegex.exec(xml)) !== null) {
    const event = match[1];
    const url = match[2].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim();
    if (url) {
      if (!trackingEvents[event]) trackingEvents[event] = [];
      trackingEvents[event].push(url);
    }
  }

  if (mediaFiles.length > 0) {
    console.log(`[vast-proxy] depth=${depth} got ${mediaFiles.length} media files: ${mediaFiles.map(m => m.type).join(',')}`);
    // Pick best video (prefer mp4, then largest)
    let best = mediaFiles[0];
    for (const mf of mediaFiles) {
      if (mf.type.includes('mp4') && !best.type.includes('mp4')) best = mf;
      else if (mf.type === best.type && mf.width > best.width) best = mf;
    }
    return {
      videoUrl: best.url,
      type: best.type,
      width: best.width,
      height: best.height,
      impressions,
      clickThrough,
      clickTracking,
      trackingEvents,
      allMediaFiles: mediaFiles,
      depth,
    };
  }

  // Check for wrapper redirect
  const wrapperMatch = xml.match(/<VASTAdTagURI[^>]*>([\s\S]*?)<\/VASTAdTagURI>/i);
  if (wrapperMatch) {
    const nextUrl = wrapperMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const nextHost = (() => { try { return new URL(nextUrl).hostname; } catch { return '?'; } })();
    console.log(`[vast-proxy] depth=${depth} wrapper -> ${nextHost}`);
    // SSRF guard — wrapper URLs are attacker-controllable through the ad chain.
    if (!isSafeVastUrl(nextUrl)) {
      console.warn(`[vast-proxy] depth=${depth} REJECTED unsafe wrapper: ${nextHost}`);
      throw new Error(`Refusing unsafe VAST wrapper URL at depth ${depth + 1}`);
    }
    const result = await resolveVast(nextUrl, depth + 1, clientIp, clientUa);
    // Merge tracking from wrapper chain. The child's terminal no-fill return
    // omits trackingEvents/clickTracking, so we default them to empty before
    // merging — otherwise a depth>0 no-fill with a tracking-bearing parent
    // throws `Cannot read properties of undefined (reading '<event>')` and
    // the whole spot fails spuriously.
    result.impressions = [...impressions, ...(result.impressions || [])];
    result.clickTracking = [...clickTracking, ...(result.clickTracking || [])];
    if (!result.trackingEvents) result.trackingEvents = {};
    for (const [event, urls] of Object.entries(trackingEvents)) {
      if (!result.trackingEvents[event]) result.trackingEvents[event] = [];
      result.trackingEvents[event] = [...urls, ...result.trackingEvents[event]];
    }
    return result;
  }

  console.log(`[vast-proxy] depth=${depth} no mediaFiles, no wrapper — terminal no-fill`);
  return { videoUrl: null, error: 'No ad fill', impressions, depth };
}
