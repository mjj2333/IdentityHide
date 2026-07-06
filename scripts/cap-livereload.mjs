#!/usr/bin/env node
// Configures Capacitor (Android or iOS) for live-reload against the local
// Vite dev server, then restores capacitor.config.json so the production
// config stays clean. The native shell keeps the dev URL until the next
// `cap sync`, so iterate freely — when you want to test the bundled build
// again, run `npm run android:sync` (or ios:sync).
//
// Usage:
//   node scripts/cap-livereload.mjs android [ip] [port]
//   node scripts/cap-livereload.mjs ios     [ip] [port]
//
// Both args optional. IP auto-detected from network interfaces (first
// non-internal IPv4 wins — pass it explicitly if your machine has multiple
// adapters and the wrong one gets picked). Port defaults to 5173.

import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { execSync } from 'node:child_process';

const [, , platformArg, ipArg, portArg] = process.argv;
const platform = platformArg;
const port = portArg || '5173';

if (!['android', 'ios'].includes(platform)) {
  console.error('Usage: node scripts/cap-livereload.mjs <android|ios> [ip] [port]');
  process.exit(1);
}

// Adapter names to skip — virtual interfaces a phone on your WiFi can't
// route to. The match is case-insensitive substring; add more patterns
// here if your machine has another type of virtual adapter that gets
// auto-selected wrongly.
const VIRTUAL_ADAPTER_PATTERNS = [
  'vmware', 'virtualbox', 'vbox', 'hyper-v', 'vethernet',
  'wsl', 'docker', 'loopback', 'bluetooth', 'tailscale', 'zerotier',
];

function isVirtualAdapter(name) {
  const lower = name.toLowerCase();
  return VIRTUAL_ADAPTER_PATTERNS.some((p) => lower.includes(p));
}

function detectLanIPs() {
  const ifs = networkInterfaces();
  const real = [];
  const virtual = [];
  for (const name of Object.keys(ifs)) {
    for (const net of ifs[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const entry = { name, address: net.address };
      (isVirtualAdapter(name) ? virtual : real).push(entry);
    }
  }
  // Prefer real adapters (Wi-Fi, Ethernet) over virtual ones (VMware,
  // Hyper-V, etc.). If for some reason you only have virtual adapters up,
  // we still fall back to those rather than giving up.
  return real.length ? real : virtual;
}

const candidates = detectLanIPs();
const ip = ipArg || candidates[0]?.address || '127.0.0.1';

if (!ipArg && candidates.length > 1) {
  console.log('[cap-dev] Multiple LAN adapters detected:');
  for (const c of candidates) {
    console.log(`[cap-dev]   - ${c.name}: ${c.address}${c.address === ip ? '  <-- using' : ''}`);
  }
  console.log('[cap-dev] If your phone cannot reach the dev server, pass the right one:');
  console.log(`[cap-dev]   npm run ${platform}:livereload -- 192.168.1.X`);
  console.log('');
}

const url = `http://${ip}:${port}`;
const configPath = 'capacitor.config.json';
const backupPath = 'capacitor.config.json.bak';

copyFileSync(configPath, backupPath);

const restore = () => {
  if (existsSync(backupPath)) {
    copyFileSync(backupPath, configPath);
    unlinkSync(backupPath);
  }
};
process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(0); });

const config = JSON.parse(readFileSync(configPath, 'utf8'));
config.server = {
  ...(config.server || {}),
  url,
  cleartext: true,
};
writeFileSync(configPath, JSON.stringify(config, null, 2));

console.log(`[cap-dev] Pointing ${platform} app at ${url}`);
console.log(`[cap-dev] Make sure Vite is running in another terminal:`);
console.log(`[cap-dev]   npm run dev -- --host`);
console.log('');

try {
  execSync(`npx cap sync ${platform}`, { stdio: 'inherit' });
} catch (err) {
  console.error('[cap-dev] Sync failed:', err.message);
  restore();
  process.exit(1);
}

restore();

console.log('');
console.log('[cap-dev] Done. capacitor.config.json restored to production state.');
console.log(`[cap-dev] The ${platform} build now points at ${url} — open it and run:`);
console.log(`[cap-dev]   npm run ${platform}:open`);
console.log('[cap-dev] To go back to the bundled build, run:');
console.log(`[cap-dev]   npm run ${platform}:sync`);
