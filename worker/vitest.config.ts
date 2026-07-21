import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const root = dirname(fileURLToPath(import.meta.url));

// Plain vitest (Node environment), not @cloudflare/vitest-pool-workers — resolveDirections
// and resolveMapsEnrichments are pure-ish functions taking primitives/mocked fetch, no
// Workers runtime bindings needed to test them.
// `root` is pinned explicitly — without it, `include` resolves against process.cwd()
// (wherever this is invoked from) rather than this directory, and picks up the app's
// own Jest tests under src/ at the repo root instead of worker/src/.
export default defineConfig({
  root,
  test: {
    include: ['src/**/*.test.ts'],
  },
});
