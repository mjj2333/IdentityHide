import { defineConfig } from '@playwright/test';

// Top-level per-test timeout. Slow CI runners can bump this via the
// E2E_TEST_TIMEOUT_MS env var without patching the config.
const TEST_TIMEOUT_MS = Number(process.env.E2E_TEST_TIMEOUT_MS) || 30_000;

export default defineConfig({
  testDir: './e2e',
  timeout: TEST_TIMEOUT_MS,
  retries: 0,
  use: {
    baseURL: 'http://localhost:4173',
    headless: true,
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
  webServer: {
    command: 'npx vite preview --port 4173',
    port: 4173,
    reuseExistingServer: true,
  },
});
