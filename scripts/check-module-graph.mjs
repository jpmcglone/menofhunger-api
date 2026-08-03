#!/usr/bin/env node
/**
 * Circular-import gate. Requires the BUILT root module and fails if Node throws.
 *
 * Why this exists: `forwardRef()` fixes Nest's *dependency injection* cycles but does nothing
 * about the *module loading* cycle. The top-level `import { X } from './x.module'` still runs, so
 * if A's import chain leads back to A, the second reference hits a class binding still in its
 * temporal dead zone and Node throws `Cannot access 'AModule' before initialization`.
 *
 * Why it runs against `dist/`: the error is specific to how the CommonJS output binds exports.
 * A jest test that requires the TypeScript source passes even when the cycle is present, because
 * the test transform emits different binding code. Only the built artifact reproduces it — which
 * is also the artifact that actually boots.
 *
 * This is the only check that catches the class of bug: lint, `tsc --noEmit`, `nest build`, and
 * the full jest suite all pass with a load-time cycle in place, and it only surfaces at startup.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, '..', 'dist', 'modules', 'app', 'app.module.js');

if (!existsSync(entry)) {
  console.error(`check-module-graph: ${entry} not found — run \`npm run build\` first.`);
  process.exit(1);
}

try {
  const require = createRequire(import.meta.url);
  const mod = require(entry);
  if (!mod?.AppModule) {
    console.error('check-module-graph: dist/modules/app/app.module.js did not export AppModule.');
    process.exit(1);
  }
  console.log('check-module-graph: module graph loads cleanly.');
} catch (err) {
  console.error('check-module-graph: the module graph failed to load.\n');
  console.error(err);
  console.error(
    '\nThis is almost always a circular import between modules. Find the two modules in the stack' +
      '\nabove and break the cycle by removing the dependency, not by adding forwardRef() —' +
      '\nforwardRef fixes DI resolution but the top-level import still executes.',
  );
  process.exit(1);
}
