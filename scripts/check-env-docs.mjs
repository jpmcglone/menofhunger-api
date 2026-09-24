#!/usr/bin/env node
/**
 * Keeps env.example in step with the variables the API actually reads.
 * Fails when a variable is read in src/ but undocumented, or documented but never read.
 * Commented-out entries (`# NAME=`) count as documented.
 *
 * Usage: node scripts/check-env-docs.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NAME = '([A-Z][A-Z0-9_]+)'
const READERS = [
  new RegExp(`\\bconfig\\.get(?:<[^>]+>)?\\(\\s*'${NAME}'`, 'g'),
  new RegExp(`\\bthis\\.read[A-Z]\\w*\\(\\s*'${NAME}'`, 'g'),
  new RegExp(`\\bprocess\\.env\\.${NAME}`, 'g'),
  new RegExp(`\\bprocess\\.env\\[\\s*'${NAME}'\\s*\\]`, 'g'),
]
const SCHEMA_KEY = new RegExp(`^\\s{2}${NAME}:`, 'gm')
// Read by tooling outside src/ rather than by the API process.
const EXTERNAL = new Set(['POSTGRES_PORT'])

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* sourceFiles(path)
    else if (path.endsWith('.ts') && !path.endsWith('.spec.ts')) yield path
  }
}

const read = new Map()
const note = (name, file) => { if (!read.has(name)) read.set(name, relative(ROOT, file)) }
for (const file of sourceFiles(join(ROOT, 'src'))) {
  const text = readFileSync(file, 'utf8')
  for (const pattern of READERS) for (const match of text.matchAll(pattern)) note(match[1], file)
}
const envSchema = join(ROOT, 'src/modules/app/env.ts')
for (const match of readFileSync(envSchema, 'utf8').matchAll(SCHEMA_KEY)) note(match[1], envSchema)

const documented = new Set(
  [...readFileSync(join(ROOT, 'env.example'), 'utf8').matchAll(new RegExp(`^#?\\s*${NAME}=`, 'gm'))].map((m) => m[1]),
)

const missing = [...read].filter(([name]) => !documented.has(name)).sort(([a], [b]) => a.localeCompare(b))
const stale = [...documented].filter((name) => !read.has(name) && !EXTERNAL.has(name)).sort()

for (const [name, file] of missing) console.error(`env.example is missing ${name} (read in ${file})`)
for (const name of stale) console.error(`env.example documents ${name}, which nothing in src/ reads`)
if (missing.length || stale.length) {
  console.error('Document each variable in env.example (commented out when optional), or remove the stale entry.')
  process.exit(1)
}
console.log(`env.example documents all ${read.size} variables the API reads.`)
