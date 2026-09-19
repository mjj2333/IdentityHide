import { getCanvasRevision } from './canvasRevision';

/**
 * Incremental session saver.
 *
 * The old auto-save PNG-encoded every pipeline canvas and rewrote the whole
 * session on every state change — including full-resolution copies of the
 * original photo that never change. Measured on a 12 MP photo: 6–12 s per
 * save, tens of MB rewritten, multi-second main-thread stalls, and saves
 * piling up on top of each other while the user kept editing.
 *
 * This keeps a fingerprint of what is already on disk and writes only the
 * difference:
 *   - a canvas is re-encoded only if it was replaced (identity) or painted on
 *     in place (canvasRevision);
 *   - a settings-only change (slider, moving a region) writes just `meta`;
 *   - the uploaded file is stored once per image;
 *   - nothing changed → nothing is encoded or written;
 *   - saves never overlap — a request made mid-save runs once afterwards with
 *     the latest state;
 *   - a session that was just restored from disk counts as saved (adopt).
 *
 * Storage-agnostic: `encode(canvas, slot)` → blob and `write({ put, remove })`
 * (one atomic batch) are injected, so the logic is unit-testable without
 * IndexedDB or a real canvas. See sessionStore.js for the real ones.
 */

const usable = (canvas) => !!canvas && canvas.width > 0 && canvas.height > 0;

function fingerprint(snapshot) {
  const slots = new Map();
  for (const [slot, canvas] of Object.entries(snapshot.canvases || {})) {
    // A freed canvas (width = 0) is the same as no canvas.
    if (usable(canvas)) slots.set(slot, { canvas, rev: getCanvasRevision(canvas) });
  }
  return {
    metaJson: JSON.stringify(snapshot.meta),
    originalFile: snapshot.originalFile || null,
    slots,
  };
}

const emptyState = () => ({ metaJson: null, originalFile: null, slots: new Map() });
const noop = () => {};

export function createSessionSaver({ encode, write }) {
  let saved = emptyState();
  // Bumped by reset(); a save that started under an older generation must not
  // write, or "Start Over" mid-save would put the discarded session back.
  let generation = 0;
  let running = null;
  let queued = null;

  async function runSave(getSnapshot) {
    const startedIn = generation;
    const snapshot = getSnapshot();
    const next = fingerprint(snapshot);
    const put = {};
    const remove = [];

    for (const [slot, current] of next.slots) {
      const previous = saved.slots.get(slot);
      if (previous && previous.canvas === current.canvas && previous.rev === current.rev) continue;
      // One at a time: on engines that encode synchronously this lets input
      // events through between canvases instead of one long block.
      put[`canvas:${slot}`] = await encode(current.canvas, slot);
      if (generation !== startedIn) return;
    }
    for (const slot of saved.slots.keys()) {
      if (!next.slots.has(slot)) remove.push(`canvas:${slot}`);
    }
    if (next.originalFile !== saved.originalFile) {
      if (next.originalFile) put.originalFile = next.originalFile;
      else remove.push('originalFile');
    }

    const unchanged = Object.keys(put).length === 0 && remove.length === 0
      && next.metaJson === saved.metaJson;
    if (unchanged || generation !== startedIn) return;

    put.meta = {
      ...snapshot.meta,
      // Lets the restore banner name the file without touching the File blob.
      filename: snapshot.originalFile?.name || null,
      savedAt: Date.now(),
    };
    await write({ put, remove });
    if (generation === startedIn) saved = next;
  }

  function start(getSnapshot) {
    const run = runSave(getSnapshot);
    running = run;
    const clear = () => { if (running === run) running = null; };
    run.then(clear, clear);
    return run;
  }

  return {
    /** `getSnapshot` is called when the save actually starts, not when requested. */
    save(getSnapshot) {
      if (!running && !queued) return start(getSnapshot);
      if (queued) {
        queued.getSnapshot = getSnapshot;
      } else {
        const entry = { getSnapshot };
        entry.promise = running.then(noop, noop).then(() => {
          queued = null;
          return start(entry.getSnapshot);
        });
        queued = entry;
      }
      return queued.promise;
    },

    /** Record `snapshot` as already on disk (call after restoring a session). */
    adopt(snapshot) {
      saved = fingerprint(snapshot);
    },

    /** Forget everything (call when the session is discarded). */
    reset() {
      generation += 1;
      saved = emptyState();
    },
  };
}
