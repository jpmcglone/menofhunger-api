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

/**
 * Walks every module reachable from the root and reports provider/controller constructor params whose
 * emitted type is `undefined` or `Object` with no explicit `@Inject()` token. SWC emits
 * `typeof X === "undefined" ? Object : X`, so a class still unloaded inside an import cycle silently
 * becomes `Object` and only fails when Nest resolves it at boot.
 */
function findUnresolvedConstructorTypes(root) {
  const seenModules = new Set();
  const seenClasses = new Set();
  const problems = [];
  const unwrap = (x) => (x && typeof x === 'object' && typeof x.forwardRef === 'function' ? x.forwardRef() : x);
  const checkClass = (cls, owner) => {
    if (typeof cls !== 'function' || seenClasses.has(cls)) return;
    seenClasses.add(cls);
    const types = Reflect.getMetadata('design:paramtypes', cls) ?? [];
    const explicit = new Set((Reflect.getMetadata('self:paramtypes', cls) ?? []).map((d) => d.index));
    types.forEach((t, i) => {
      if (explicit.has(i) || (t !== undefined && t !== Object)) return;
      problems.push(`${owner} > ${cls.name} constructor param[${i}]`);
    });
  };
  const visitDefinition = (owner, def) => {
    for (const p of def.providers ?? []) checkClass(typeof p === 'function' ? p : p?.useClass, owner);
    for (const c of def.controllers ?? []) checkClass(c, owner);
    for (const i of def.imports ?? []) visit(i);
  };
  const visit = (entry) => {
    const resolved = unwrap(entry);
    if (!resolved || seenModules.has(resolved)) return;
    seenModules.add(resolved);
    if (typeof resolved === 'object') {
      if (typeof resolved.module !== 'function') return;
      visitDefinition(resolved.module.name, resolved);
      visit(resolved.module);
      return;
    }
    visitDefinition(resolved.name, {
      providers: Reflect.getMetadata('providers', resolved),
      controllers: Reflect.getMetadata('controllers', resolved),
      imports: Reflect.getMetadata('imports', resolved),
    });
  };
  visit(root);
  return problems;
}

// Loading AppModule runs env validation, but this check never connects to anything. Docker builds
// have no `.env` (see .dockerignore), so supply a placeholder rather than fail the build.
process.env.DATABASE_URL ||= 'postgresql://module-graph-check@localhost:5432/unused';

try {
  const require = createRequire(import.meta.url);
  const mod = require(entry);
  if (!mod?.AppModule) {
    console.error('check-module-graph: dist/modules/app/app.module.js did not export AppModule.');
    process.exit(1);
  }
  const unresolved = findUnresolvedConstructorTypes(mod.AppModule);
  if (unresolved.length) {
    console.error('check-module-graph: constructor parameter types are missing at load time:\n');
    for (const line of unresolved) console.error(`  ${line}`);
    console.error(
      '\nNest would fail to resolve these at startup. The injected class was `undefined` when the' +
        '\nconsumer loaded, usually because it came through a barrel (`../x`) that sits in an import' +
        '\ncycle. Import the class from its own file (`../x/x.service`) instead.',
    );
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
