/**
 * Adsterra popunder integration.
 *
 * The provided script is a standard Adsterra popunder tag — it installs a
 * click listener on document and opens a popunder window on the first
 * qualifying click after load. Once the script is loaded it handles everything;
 * we just need to inject the <script> tag at the right moment.
 *
 * Trigger: load-on-editor-mount. Because popunders need the script ready
 * before the click fires (load+click would race), we inject on MaskEditorScreen
 * mount so the script is ready by the time the user taps Apply. First
 * qualifying click anywhere in the editor (typically Apply) triggers the
 * popunder. Load-once-per-session guarded by a module-level flag.
 *
 * To disable:  set ADSTERRA_ENABLED = false (everything no-ops).
 * To remove:   delete this file and remove the call in MaskEditorScreen.jsx.
 */

// Disabled — Adsterra served as cross-origin popunders instead of in-app
// video interstitials, which is worse UX for this flow. Kept as off-switch
// code so it can be re-enabled later or used as a fallback if needed.
export const ADSTERRA_ENABLED = false;

const ADSTERRA_SCRIPT_SRC = 'https://pl29183657.profitablecpmratenetwork.com/78/1e/7f/781e7fe311d6facdaeee73208ca0a6b4.js';

let loaded = false;

export function loadAdsterraPopunder() {
  if (!ADSTERRA_ENABLED) return;
  if (loaded) return;
  if (typeof document === 'undefined') return;
  loaded = true;

  const s = document.createElement('script');
  s.src = ADSTERRA_SCRIPT_SRC;
  s.async = true;
  s.addEventListener('error', () => {
    // Allow retry on next editor mount if the first load failed
    // (e.g., transient network / blocker).
    loaded = false;
  });
  document.head.appendChild(s);
}
