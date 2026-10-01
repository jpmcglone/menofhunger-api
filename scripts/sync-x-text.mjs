// Run from the API repo after installing its pinned twitter-text dependency.
// Uses the web project's existing esbuild; does not install an alternate build stack.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const require = createRequire(new URL('../../menofhunger-www/package.json', import.meta.url));
const { build } = require('esbuild');
const root = resolve(import.meta.dirname, '..');
const check = process.argv.includes('--check');
const targets = [
  ['../menofhunger-www/utils/vendor/x-text.js', 'esm'],
  ['../menofhunger-ios/MenOfHunger/App/Resources/x-text.js', 'iife'],
];
for (const [file, format] of targets) {
  const result = await build({ entryPoints: [resolve(root, 'scripts/x-text/entry.cjs')], bundle: true, write: false,
    metafile: true, format, globalName: format === 'iife' ? 'MOHXText' : undefined, minify: true, target: 'es2020',
    banner: { js: '// Generated from twitter-text 3.1.0. Do not edit. Apache-2.0; see x-text.LICENSE.' } });
  const path = resolve(root, file);
  const packages = new Set(['twitter-text']);
  for (const file of Object.keys(result.metafile.inputs)) {
    const match = file.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (match) packages.add(match[1]);
  }
  const licenses = [...packages].sort().map(name => {
    const folder = resolve(root, 'node_modules', name);
    for (const file of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'license', 'license.md']) {
      try { return `\n===== ${name} =====\n${readFileSync(resolve(folder, file), 'utf8')}`; } catch {}
    }
    throw new Error(`Missing bundled license: ${name}`);
  }).join('\n');
  for (const [target, contents] of [[path, result.outputFiles[0].text], [resolve(path, '../x-text.LICENSE'), licenses]]) {
    if (check) {
      if (readFileSync(target, 'utf8') !== contents) throw new Error(`Generated X parser drift: ${target}`);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
  }
}
