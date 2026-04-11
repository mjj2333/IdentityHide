// Shared E2E helpers. Timeouts are env-driven so slow CI runners can bump
// them without touching spec files:
//   E2E_ACTION_TIMEOUT_MS=20000 npm run test:e2e
// Defaults match the previous hard-coded 10s values.
const ACTION_TIMEOUT_MS = Number(process.env.E2E_ACTION_TIMEOUT_MS) || 10_000;

export { ACTION_TIMEOUT_MS };
