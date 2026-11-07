// Which channel this native build was installed from.
//
// iOS TestFlight builds are ad-free for the people invited to test them; App
// Store users see ads as usual. The answer comes from a tiny native plugin
// (BuildChannelPlugin in ios/App/App/AppDelegate.swift). Anything unexpected
// (Android, the web, an older binary without the plugin, no answer) keeps
// ads on.
import { getNativePlatform } from './platform';

const NATIVE_TIMEOUT = 3000;
let pending = null;

export function isAdFreeBuild() {
  if (getNativePlatform() !== 'ios') return Promise.resolve(false);
  if (!pending) {
    pending = (async () => {
      try {
        const { registerPlugin } = await import('@capacitor/core');
        const ask = registerPlugin('BuildChannel').get();
        const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NATIVE_TIMEOUT));
        const result = await Promise.race([ask, timeout]);
        return result?.channel === 'testflight';
      } catch {
        return false;
      }
    })();
  }
  return pending;
}

export function _resetForTests() {
  pending = null;
}
