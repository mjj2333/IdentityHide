import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Single build-time version string shared by the service worker and Sentry's
// release tag, so a crash and its matching SW cache version always line up.
const BUILD_VERSION = `b${Date.now().toString(36)}`

// Stamp sw.js with a unique version on every build so CACHE_VERSION is
// guaranteed to change on each deploy (no more hand-bumping 'v2' → 'v3').
function swVersionPlugin() {
  return {
    name: 'sw-version-stamp',
    apply: 'build',
    closeBundle() {
      const swPath = resolve(__dirname, 'dist/sw.js')
      try {
        const src = readFileSync(swPath, 'utf8')
        writeFileSync(swPath, src.replace('__SW_VERSION__', BUILD_VERSION))
        console.log(`[sw-version-stamp] sw.js CACHE_VERSION = ${BUILD_VERSION}`)
      } catch (e) {
        console.warn('[sw-version-stamp] failed to stamp sw.js:', e.message)
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), swVersionPlugin()],
  define: {
    // Used by src/utils/sentry.js as the release tag so a given deploy's
    // frontend errors match its service worker CACHE_VERSION.
    __BUILD_VERSION__: JSON.stringify(BUILD_VERSION),
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    // Capacitor's `cap copy` writes the built web bundle into the native
    // shells under ios/App/App/public and android/app/src/main/assets/public.
    // Vite's file watcher mirrors source files, so it tries to watch those
    // sync targets too — and crashes on Windows ("scandir UNKNOWN") when the
    // sync rewrites the directory mid-scan. Excluding them from the watcher
    // keeps the dev server stable while still letting `cap copy` do its job.
    watch: {
      ignored: ['**/ios/**', '**/android/**'],
    },
  },
  // Strip development-only console calls from production bundles. console.warn
  // and console.error are preserved so genuine problems still reach Sentry /
  // the browser devtools in the wild. esbuild treats `pure` calls as
  // side-effect-free and drops them when their return value is unused — which
  // is always the case for `console.log('...')` in statement position.
  esbuild: {
    pure: ['console.log', 'console.debug', 'console.info'],
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
  test: {
    // Unit/component specs live under src/**/__tests__/. Playwright specs in
    // e2e/ would otherwise be discovered by vitest and crash on the missing
    // `@playwright/test` runtime — exclude them explicitly.
    include: ['src/**/*.{test,spec}.{js,jsx}'],
    exclude: ['node_modules', 'dist', 'e2e'],
  },
})
