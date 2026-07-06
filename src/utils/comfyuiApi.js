/**
 * ComfyUI API client for Redact.ID.
 * Handles image upload, prompt queueing, WebSocket progress, and result download.
 */

import { buildTattooRemovalWorkflow } from './comfyuiWorkflows.js';

const DEFAULT_URL = 'https://identity-hide.com';
// Auth token checked by Cloudflare WAF — passed as query param to avoid CORS preflight issues.
const COMFYUI_AUTH_TOKEN = 'uADaVMXiAivsGxNYi6ezrqBmfRKi_AsbZPmqyoBCzUw';

/** Append auth query param to a URL. */
function withAuth(url) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}auth=${COMFYUI_AUTH_TOKEN}`;
}
const WS_CONNECT_TIMEOUT = 3000;
const HISTORY_RETRY_INITIAL_DELAY = 300;
const HISTORY_RETRY_BACKOFF = 1.5;
const HISTORY_RETRY_MAX_DELAY = 2000;
const HISTORY_MAX_RETRIES = 10;
const FALLBACK_POLL_INTERVAL = 500;
// Hard ceiling on the polling fallback so the user can't get stuck on
// "Processing..." forever if ComfyUI accepts the queue but never reports
// completion. 5 minutes is comfortably longer than any normal Flux inpaint.
const FALLBACK_POLL_MAX_MS = 5 * 60 * 1000;
// Per-fetch ceiling inside fallbackPoll so a single slow/hung connection
// doesn't block the overall-timeout check (which only runs between ticks).
const POLL_FETCH_TIMEOUT_MS = 5000;
const CONNECTION_TEST_TIMEOUT = 5000;
const PREWARM_CANVAS_SIZE = 128;

// Guard localStorage access so this module is safe to import in non-browser
// contexts (Node-based tests, SSR, service workers) where `localStorage` is
// undefined or throws on access (e.g. privacy mode).
let baseUrl = DEFAULT_URL;
try {
  baseUrl = globalThis.localStorage?.getItem('comfyui-url') || DEFAULT_URL;
} catch { /* localStorage unavailable — fall back to default */ }

export function getComfyUrl() { return baseUrl; }

export function setComfyUrl(url) {
  baseUrl = url.replace(/\/+$/, '');
  try {
    globalThis.localStorage?.setItem('comfyui-url', baseUrl);
  } catch { /* persistence unavailable — in-memory only */ }
}

/**
 * Generate a client ID, with fallback for non-secure contexts.
 */
function makeClientId() {
  try { return crypto.randomUUID(); } catch {}
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// Stable client ID for the session — must match between WebSocket and prompt queue
const CLIENT_ID = makeClientId();

/**
 * Best-effort cancel of a queued/running prompt. Fire-and-forget — errors
 * are swallowed because the caller is already in an error/abort path.
 * Tries to delete from queue first (pending), then interrupts if running.
 */
function cancelPrompt(promptId) {
  // Remove from pending queue
  fetch(withAuth(`${baseUrl}/queue`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delete: [promptId] }),
  }).catch(() => {});
  // Interrupt if currently running
  fetch(withAuth(`${baseUrl}/interrupt`), { method: 'POST' }).catch(() => {});
  console.warn(`[ComfyUI] Cancelled prompt ${promptId}`);
}

/**
 * Upload an image (canvas) to ComfyUI's /upload/image endpoint.
 * Returns the filename assigned by ComfyUI.
 * Pass `signal` to make the upload cancellable — without it, hitting Cancel
 * mid-upload still sends the full image and consumes VRAM on the server side
 * before the caller's abort check fires.
 */
export async function uploadImage(canvas, filename = 'input.png', { signal } = {}) {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const form = new FormData();
  form.append('image', blob, filename);

  const res = await fetch(withAuth(`${baseUrl}/upload/image`), {
    method: 'POST',
    body: form,
    signal,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const data = await res.json();
  return data.name; // ComfyUI returns { name, subfolder, type }
}

/**
 * Upload a mask canvas to ComfyUI.
 * ComfyUI expects masks as images — white = masked region.
 * Pass `signal` to forward cancellation down to the underlying fetch.
 */
export async function uploadMask(maskCanvas, filename = 'mask.png', { signal } = {}) {
  // Convert alpha-based mask to RGB white-on-black for ComfyUI
  const { width, height } = maskCanvas;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  const src = maskCanvas.getContext('2d').getImageData(0, 0, width, height);
  const dst = ctx.createImageData(width, height);
  for (let i = 0; i < src.data.length; i += 4) {
    const on = src.data[i + 3] > 128 ? 255 : 0;
    dst.data[i] = on;
    dst.data[i + 1] = on;
    dst.data[i + 2] = on;
    dst.data[i + 3] = 255;
  }
  ctx.putImageData(dst, 0, 0);
  return uploadImage(c, filename, { signal });
}

/**
 * Queue a prompt (workflow) on ComfyUI.
 * Returns { prompt_id }.
 */
export async function queuePrompt(workflow) {
  const res = await fetch(withAuth(`${baseUrl}/prompt`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: CLIENT_ID }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`[ComfyUI] Queue failed: ${res.status} — ${text}`);
    throw new Error(`Queue failed (${res.status})`);
  }
  return res.json(); // { prompt_id, number, node_errors }
}

// Node labels for user-friendly progress messages
const NODE_LABELS = {
  '3': 'Loading model...',
  '4': 'Loading CLIP...',
  '5': 'Loading VAE...',
  '6': 'Applying LoRA...',
  '14': 'Decoding image...',
};

/**
 * Queue a workflow and wait for completion with real-time WebSocket progress.
 * Connects WebSocket BEFORE queueing so no events are missed.
 * Falls back to HTTP polling if WebSocket fails.
 */
export async function queueAndWait(workflow, { onProgress, signal } = {}) {
  // Step 1: Try to connect WebSocket before queueing
  let ws = null;
  try {
    const wsUrl = baseUrl.replace(/^http/, 'ws') + `/ws?clientId=${CLIENT_ID}&auth=${COMFYUI_AUTH_TOKEN}`;
    ws = new WebSocket(wsUrl);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), WS_CONNECT_TIMEOUT);
      ws.onopen = () => { clearTimeout(timeout); resolve(); };
      ws.onerror = () => { clearTimeout(timeout); reject(new Error('ws error')); };
    });

    console.log('[ComfyUI] WebSocket connected for progress tracking');
  } catch (e) {
    console.warn('[ComfyUI] WebSocket setup failed:', e.message, '— will use polling');
    try { ws?.close(); } catch {}
    ws = null;
  }

  // Step 2: Queue the prompt (with client_id so ComfyUI routes events to us)
  const res = await fetch(withAuth(`${baseUrl}/prompt`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: CLIENT_ID }),
  });
  if (!res.ok) {
    try { ws?.close(); } catch {}
    const text = await res.text().catch(() => '');
    console.warn(`[ComfyUI] Queue failed: ${res.status} — ${text}`);
    throw new Error(`Queue failed (${res.status})`);
  }
  const { prompt_id } = await res.json();
  console.log(`[ComfyUI] Queued prompt: ${prompt_id}`);

  // Step 3: Wait for completion via WebSocket or polling
  if (ws) {
    return waitViaWebSocket(ws, prompt_id, { onProgress, signal });
  }
  return fallbackPoll(prompt_id, { onProgress, signal });
}

/**
 * Wait for prompt completion via an already-connected WebSocket.
 */
function waitViaWebSocket(ws, promptId, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;

    const finish = (result, isError = false) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      if (isError) reject(result);
      else resolve(result);
    };

    if (signal) {
      signal.addEventListener('abort', () => {
        cancelPrompt(promptId);
        finish(new Error('Cancelled'), true);
      }, { once: true });
    }

    let highWater = 0;
    ws.onmessage = async (event) => {
      if (done) return;
      if (typeof event.data !== 'string') return;
      try {
        const msg = JSON.parse(event.data);
        const d = msg.data;

        // Ignore events for other prompts
        if (d?.prompt_id && d.prompt_id !== promptId) return;

        switch (msg.type) {
          case 'progress': {
            // KSampler step progress — map to 10%–90%
            const frac = 0.1 + (d.value / d.max) * 0.8;
            highWater = Math.max(highWater, frac);
            onProgress?.({ message: `Step ${d.value}/${d.max}`, fraction: frac });
            break;
          }

          case 'executing': {
            if (d.node === null) {
              // All nodes finished — fetch result from history
              onProgress?.({ message: 'Saving result...', fraction: 0.95 });
              try {
                const result = await fetchHistory(promptId);
                onProgress?.({ message: 'Done', fraction: 1 });
                finish(result);
              } catch (err) {
                finish(err, true);
              }
            } else {
              const label = NODE_LABELS[d.node] || 'Preparing...';
              // Never report progress lower than what we've already reached
              const frac = Math.max(highWater, 0.05);
              onProgress?.({ message: label, fraction: frac });
            }
            break;
          }

          case 'execution_error': {
            console.warn('[ComfyUI] Execution error:', d.exception_message, d);
            finish(new Error('Processing failed — please try again'), true);
            break;
          }
        }
      } catch {
        // Ignore unparseable messages
      }
    };

    const fallbackAndCleanup = (reason) => {
      if (done) return;
      console.warn(`[ComfyUI] WebSocket ${reason} during wait, falling back to polling`);
      done = true;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try { ws.close(); } catch {}
      fallbackPoll(promptId, { onProgress, signal }).then(resolve, reject);
    };

    ws.onerror = () => fallbackAndCleanup('error');
    ws.onclose = () => fallbackAndCleanup('closed');
  });
}

/**
 * Fetch the history entry for a completed prompt, with retries.
 */
async function fetchHistory(promptId) {
  let delay = HISTORY_RETRY_INITIAL_DELAY;
  for (let i = 0; i < HISTORY_MAX_RETRIES; i++) {
    const res = await fetch(withAuth(`${baseUrl}/history/${promptId}`));
    if (!res.ok) throw new Error(`History fetch failed: ${res.status}`);
    const data = await res.json();
    if (data[promptId]) {
      const entry = data[promptId];
      if (entry.status?.status_str === 'error') {
        console.warn('[ComfyUI] Workflow failed:', entry.status);
        throw new Error('Processing failed — please try again');
      }
      return entry;
    }
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * HISTORY_RETRY_BACKOFF, HISTORY_RETRY_MAX_DELAY);
  }
  throw new Error('Timed out waiting for result in history');
}

/**
 * Fallback: poll for completion via HTTP if WebSocket is unavailable.
 */
async function fallbackPoll(promptId, { onProgress, signal, pollInterval = FALLBACK_POLL_INTERVAL } = {}) {
  const startedAt = Date.now();
  // Coarse heartbeat fraction so the progress bar advances even though we
  // can't see real KSampler step events on the polling path.
  let heartbeat = 0.1;

  // Per-fetch timeout combined with the caller's cancel signal. Without a
  // per-fetch cap a hung ComfyUI connection blocks the loop indefinitely
  // and the FALLBACK_POLL_MAX_MS overall-limit check at the top never
  // fires (it only runs between iterations).
  const pollSignal = () => {
    const timeout = AbortSignal.timeout(POLL_FETCH_TIMEOUT_MS);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  };

  while (true) {
    if (signal?.aborted) {
      cancelPrompt(promptId);
      throw new Error('Cancelled');
    }
    if (Date.now() - startedAt > FALLBACK_POLL_MAX_MS) {
      cancelPrompt(promptId);
      throw new Error('ComfyUI did not return a result within 5 minutes');
    }

    let res;
    try {
      res = await fetch(withAuth(`${baseUrl}/history/${promptId}`), { signal: pollSignal() });
    } catch (err) {
      // Translate caller-abort into the loop's "Cancelled" error so the
      // user-visible message doesn't read "The operation was aborted".
      if (signal?.aborted) {
        cancelPrompt(promptId);
        throw new Error('Cancelled');
      }
      throw new Error(`History poll failed: ${err.message || 'timeout'}`);
    }
    if (!res.ok) throw new Error(`History poll failed: ${res.status}`);
    const data = await res.json();

    if (data[promptId]) {
      const entry = data[promptId];
      if (entry.status?.status_str === 'error') {
        console.warn('[ComfyUI] Workflow failed:', entry.status);
        throw new Error('Processing failed — please try again');
      }
      return entry;
    }

    try {
      const qRes = await fetch(withAuth(`${baseUrl}/queue`), { signal: pollSignal() });
      const qData = await qRes.json();
      const running = qData.queue_running?.find(q => q[1] === promptId);
      const pending = qData.queue_pending?.findIndex(q => q[1] === promptId);
      if (running && onProgress) {
        // Walk the heartbeat slowly toward 0.9 so the user sees liveness
        // even though we can't subscribe to per-step progress here.
        heartbeat = Math.min(0.9, heartbeat + 0.01);
        onProgress({ message: 'Processing...', fraction: heartbeat });
      } else if (pending >= 0 && onProgress) {
        onProgress({ message: `Queued (position ${pending + 1})...`, fraction: 0.1 });
      }
    } catch { /* ignore queue check errors (incl. per-fetch timeout) */ }

    await new Promise(r => setTimeout(r, pollInterval));
  }
}

/**
 * Download an output image from ComfyUI history as a canvas.
 */
export async function downloadOutputImage(historyEntry, nodeId, { signal } = {}) {
  const outputs = historyEntry.outputs;
  if (!outputs[nodeId]?.images?.length) {
    throw new Error(`No output images found for node ${nodeId}`);
  }

  const img = outputs[nodeId].images[0];
  const url = `${baseUrl}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${encodeURIComponent(img.type || 'output')}`;

  const res = await fetch(withAuth(url), { signal });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const blob = await res.blob();

  return new Promise((resolve, reject) => {
    const imgEl = new Image();
    imgEl.onload = () => {
      const c = document.createElement('canvas');
      c.width = imgEl.naturalWidth;
      c.height = imgEl.naturalHeight;
      c.getContext('2d').drawImage(imgEl, 0, 0);
      URL.revokeObjectURL(imgEl.src);
      resolve(c);
    };
    imgEl.onerror = () => { URL.revokeObjectURL(imgEl.src); reject(new Error('Failed to decode output')); };
    imgEl.src = URL.createObjectURL(blob);
  });
}

/**
 * Prewarm Flux models by running a tiny 1-step job.
 * ComfyUI caches loaded models in VRAM, so subsequent real jobs skip
 * the ~15-30s model-loading phase entirely.
 * Fire-and-forget — call once when user enters the mask editor.
 */
let _prewarmed = false;
export async function prewarmFluxModels() {
  if (_prewarmed) return;
  _prewarmed = true;

  try {
    // Small 128x128 image + all-white mask (must meet Flux VAE stride requirements)
    const tiny = document.createElement('canvas');
    tiny.width = PREWARM_CANVAS_SIZE;
    tiny.height = PREWARM_CANVAS_SIZE;
    const ctx = tiny.getContext('2d');
    ctx.fillStyle = '#888888';
    ctx.fillRect(0, 0, PREWARM_CANVAS_SIZE, PREWARM_CANVAS_SIZE);

    const mask = document.createElement('canvas');
    mask.width = PREWARM_CANVAS_SIZE;
    mask.height = PREWARM_CANVAS_SIZE;
    const mCtx = mask.getContext('2d');
    mCtx.fillStyle = '#ffffff';
    mCtx.fillRect(0, 0, PREWARM_CANVAS_SIZE, PREWARM_CANVAS_SIZE);

    const imgName = await uploadImage(tiny, 'prewarm_img.png');
    const maskName = await uploadMask(mask, 'prewarm_mask.png');

    // Same workflow structure but 1 step — just enough to force model loading
    const workflow = buildTattooRemovalWorkflow(imgName, maskName, { steps: 1 });

    await queuePrompt(workflow);
    console.log('[ComfyUI] Prewarm job queued — models will be cached in VRAM');
  } catch (e) {
    console.warn('[ComfyUI] Prewarm failed (non-fatal):', e.message);
    _prewarmed = false; // Allow retry on next entry
  }
}

/**
 * Test connectivity to ComfyUI.
 */
export async function testConnection() {
  try {
    const res = await fetch(withAuth(`${baseUrl}/system_stats`), { signal: AbortSignal.timeout(CONNECTION_TEST_TIMEOUT) });
    return res.ok;
  } catch {
    return false;
  }
}
