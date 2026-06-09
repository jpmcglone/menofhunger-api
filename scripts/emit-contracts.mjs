#!/usr/bin/env node
/**
 * emit:contracts — generate the shared API contract types file.
 *
 * Walks the DTO sources (src/common/dto/** plus the module-level DTO files),
 * extracts every exported `type` alias that is a pure client contract, inlines
 * Prisma enum types as string-literal unions, and emits a single generated
 * TypeScript file:
 *
 *   - menofhunger-api/contracts/api-contracts.gen.ts   (committed; CI drift gate)
 *   - menofhunger-www/types/api-contracts.gen.ts       (when the sibling repo exists)
 *
 * Server-only types are excluded automatically:
 *   - aliases whose names match /(Row|WithRelations|WithOptional|WithUser|WithAuthorAndMedia)$/
 *   - aliases that (transitively) reference Prisma model types or other
 *     non-contract types that can't be resolved to literal unions
 *
 * Usage: npm run emit:contracts
 * CI:    npm run emit:contracts && git diff --exit-code contracts/
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

// ─── Collect DTO source files ────────────────────────────────────────────────

function listTsFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTsFiles(full))
    else if (entry.name.endsWith('.ts') && entry.name !== 'index.ts') out.push(full)
  }
  return out
}

const dtoFiles = [
  ...listTsFiles(resolve(REPO, 'src/common/dto')),
  resolve(REPO, 'src/modules/messages/message.dto.ts'),
  resolve(REPO, 'src/modules/notifications/notification.dto.ts'),
  // Not a DTO file, but defines contract types referenced by UserDto.
  resolve(REPO, 'src/common/feature-toggles.ts'),
].filter((f) => existsSync(f))

// ─── TypeScript program ──────────────────────────────────────────────────────

const tsconfigPath = resolve(REPO, 'tsconfig.json')
const tsconfig = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(tsconfig.config, ts.sys, REPO)
const program = ts.createProgram(dtoFiles, parsed.options)
const checker = program.getTypeChecker()

const SERVER_ONLY_NAME = /(Row|WithRelations|WithOptional|WithUser|WithAuthorAndMedia)$/
// Names that match the server-only pattern but are genuine client contracts.
const KEEP_NAMES = new Set(['AdminAnalyticsRetentionRow'])

/** name → { name, node, sourceFile, filePath } */
const aliases = new Map()
const duplicateNames = []

for (const filePath of dtoFiles) {
  const sourceFile = program.getSourceFile(filePath)
  if (!sourceFile) continue
  for (const stmt of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(stmt)) continue
    const name = stmt.name.text
    const isExported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    const entry = { name, node: stmt, sourceFile, filePath, exported: Boolean(isExported) }
    if (aliases.has(name)) {
      duplicateNames.push(name)
      continue
    }
    aliases.set(name, entry)
  }
}

if (duplicateNames.length > 0) {
  console.error(`[emit-contracts] duplicate type alias names across DTO files: ${duplicateNames.join(', ')}`)
  console.error('Rename them so the single-file contract emit stays unambiguous.')
  process.exit(1)
}

// ─── Symbol classification ───────────────────────────────────────────────────

function declarationPaths(symbol) {
  let sym = symbol
  if (sym && sym.flags & ts.SymbolFlags.Alias) {
    try {
      sym = checker.getAliasedSymbol(sym)
    } catch {
      // keep original
    }
  }
  return (sym?.declarations ?? []).map((d) => d.getSourceFile().fileName)
}

function isPrismaPath(p) {
  return p.includes('node_modules/.prisma/client') || p.includes('node_modules/@prisma/client')
}

// Built-ins (lib.*.d.ts) plus ambient augmentations from @types/* packages.
function isBuiltinPath(p) {
  return p.includes('node_modules/')
}

function isDtoSetPath(p) {
  return dtoFiles.some((f) => resolve(f) === resolve(p))
}

/** Returns a 'a' | 'b' union string when the type is a union of string/number literals, else null. */
function literalUnionText(type) {
  if (type.flags & ts.TypeFlags.Never) return 'never'
  const parts = type.isUnion() ? type.types : [type]
  const literals = []
  for (const t of parts) {
    if (t.flags & ts.TypeFlags.StringLiteral) literals.push(`'${t.value}'`)
    else if (t.flags & ts.TypeFlags.NumberLiteral) literals.push(String(t.value))
    else if (t.flags & ts.TypeFlags.BooleanLiteral) literals.push(checker.typeToString(t))
    else if (t.flags & ts.TypeFlags.Null) literals.push('null')
    else return null
  }
  if (literals.length === 0) return null
  return [...new Set(literals)].join(' | ')
}

// Prisma enums referenced by name: emit one named alias each, keep reference sites as-is.
const prismaEnumAliases = new Map() // name → union text

/**
 * Analyze one alias body. Returns:
 *   { ok: true, replacements: [{ start, end, text }], deps: Set<string> }
 *   { ok: false, reason }
 */
function analyzeAlias(entry) {
  const replacements = []
  const deps = new Set()
  let failure = null

  function fail(reason) {
    if (!failure) failure = reason
  }

  function visit(node) {
    if (failure) return

    // import('./x').Y → Y  (single-file emit; Y must be in the emitted set)
    if (ts.isImportTypeNode(node)) {
      const qualifier = node.qualifier
      if (qualifier && ts.isIdentifier(qualifier)) {
        deps.add(qualifier.text)
        replacements.push({ start: node.getStart(), end: node.getEnd(), text: qualifier.text })
        return
      }
      fail(`unsupported import() type without simple qualifier`)
      return
    }

    // Model['field'] (Prisma model) → inline literal union when possible.
    if (ts.isIndexedAccessTypeNode(node) && ts.isTypeReferenceNode(node.objectType)) {
      const objSym = checker.getSymbolAtLocation(node.objectType.typeName)
      const paths = objSym ? declarationPaths(objSym) : []
      if (paths.some(isPrismaPath)) {
        const type = checker.getTypeAtLocation(node)
        const union = literalUnionText(type)
        if (union) {
          replacements.push({ start: node.getStart(), end: node.getEnd(), text: union })
          return
        }
        fail(`indexed access ${node.getText()} does not resolve to a literal union`)
        return
      }
    }

    // (typeof SOME_CONST)[number] and friends → resolve to a literal union;
    // the referenced const doesn't exist in the generated file.
    if (ts.isIndexedAccessTypeNode(node) || ts.isTypeQueryNode(node)) {
      const containsTypeQuery = (n) =>
        ts.isTypeQueryNode(n) || ts.forEachChild(n, containsTypeQuery) === true
      if (containsTypeQuery(node) === true || ts.isTypeQueryNode(node)) {
        const type = checker.getTypeAtLocation(node)
        const union = literalUnionText(type)
        if (union) {
          replacements.push({ start: node.getStart(), end: node.getEnd(), text: union })
          return
        }
        fail(`typeof-based type ${node.getText()} does not resolve to a literal union`)
        return
      }
    }

    if (ts.isTypeReferenceNode(node)) {
      const typeName = node.typeName
      if (ts.isIdentifier(typeName)) {
        const name = typeName.text
        const sym = checker.getSymbolAtLocation(typeName)
        const paths = sym ? declarationPaths(sym) : []

        if (paths.length === 0) {
          // Unresolved (e.g. global like Array in some configs) — treat as ok.
        } else if (paths.some(isPrismaPath)) {
          const type = checker.getTypeAtLocation(node)
          const union = literalUnionText(type)
          if (union) {
            prismaEnumAliases.set(name, union)
          } else {
            fail(`references Prisma model type ${name}`)
            return
          }
        } else if (paths.some(isDtoSetPath)) {
          deps.add(name)
        } else if (paths.every(isBuiltinPath)) {
          // Built-in (Array, Record, Date, …) plus @types/* ambient augmentations — ok.
        } else {
          fail(`references non-DTO type ${name}`)
          return
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(entry.node.type)

  if (failure) return { ok: false, reason: failure }
  return { ok: true, replacements, deps }
}

// ─── Analyze all aliases, then exclude transitively-broken ones ──────────────

const analysis = new Map()
for (const [name, entry] of aliases) {
  if (SERVER_ONLY_NAME.test(name) && !KEEP_NAMES.has(name)) {
    analysis.set(name, { ok: false, reason: 'server-only naming convention' })
    continue
  }
  if (!entry.exported) {
    analysis.set(name, { ok: false, reason: 'not exported' })
    continue
  }
  analysis.set(name, analyzeAlias(entry))
}

let changed = true
while (changed) {
  changed = false
  for (const [name, a] of analysis) {
    if (!a.ok) continue
    for (const dep of a.deps) {
      const depAnalysis = analysis.get(dep)
      if (!depAnalysis) {
        analysis.set(name, { ok: false, reason: `depends on unknown type ${dep}` })
        changed = true
        break
      }
      if (!depAnalysis.ok) {
        analysis.set(name, { ok: false, reason: `depends on excluded type ${dep} (${depAnalysis.reason})` })
        changed = true
        break
      }
    }
  }
}

// ─── Emit ────────────────────────────────────────────────────────────────────

function emitAlias(entry, replacements) {
  const sf = entry.sourceFile
  const text = sf.getFullText()
  const jsdocStart = (() => {
    // Include the leading JSDoc comment when it's directly attached.
    const ranges = ts.getLeadingCommentRanges(text, entry.node.getFullStart()) ?? []
    const last = ranges[ranges.length - 1]
    if (last && text.slice(last.pos, last.end).startsWith('/**')) return last.pos
    return entry.node.getStart()
  })()
  const start = jsdocStart
  const end = entry.node.getEnd()

  const sorted = [...replacements].sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = start
  for (const r of sorted) {
    out += text.slice(cursor, r.start) + r.text
    cursor = r.end
  }
  out += text.slice(cursor, end)
  return out
}

const sections = new Map() // filePath → emitted alias texts
const excluded = []
for (const [name, entry] of aliases) {
  const a = analysis.get(name)
  if (!a.ok) {
    excluded.push({ name, reason: a.reason })
    continue
  }
  const rel = entry.filePath.slice(REPO.length + 1)
  if (!sections.has(rel)) sections.set(rel, [])
  sections.get(rel).push(emitAlias(entry, a.replacements))
}

const lines = []
lines.push('/* eslint-disable */')
lines.push('/**')
lines.push(' * GENERATED FILE — DO NOT EDIT.')
lines.push(' *')
lines.push(' * Source of truth: menofhunger-api/src/common/dto/** (and module DTO files).')
lines.push(' * Regenerate with `npm run emit:contracts` from menofhunger-api/.')
lines.push(' *')
lines.push(' * Prisma enums are inlined as string-literal unions; server-only row/mapper')
lines.push(' * types are excluded.')
lines.push(' */')
lines.push('')

if (prismaEnumAliases.size > 0) {
  lines.push('// ─── Prisma enums (inlined) ───────────────────────────────────────────────')
  lines.push('')
  for (const [name, union] of [...prismaEnumAliases].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`export type ${name} = ${union}`)
  }
  lines.push('')
}

for (const [rel, texts] of sections) {
  lines.push(`// ─── ${rel} ${'─'.repeat(Math.max(3, 74 - rel.length))}`)
  lines.push('')
  for (const t of texts) {
    lines.push(t.trim())
    lines.push('')
  }
}

const output = lines.join('\n')

const apiOut = resolve(REPO, 'contracts/api-contracts.gen.ts')
mkdirSync(dirname(apiOut), { recursive: true })
writeFileSync(apiOut, output)
console.log(`[emit-contracts] wrote ${apiOut}`)

const wwwTypesDir = resolve(REPO, '../menofhunger-www/types')
if (existsSync(wwwTypesDir)) {
  const wwwOut = join(wwwTypesDir, 'api-contracts.gen.ts')
  writeFileSync(wwwOut, output)
  console.log(`[emit-contracts] wrote ${wwwOut}`)
} else {
  console.log('[emit-contracts] sibling menofhunger-www not found; skipped copy')
}

const emittedCount = [...sections.values()].reduce((n, t) => n + t.length, 0)
console.log(`[emit-contracts] emitted ${emittedCount} types, ${prismaEnumAliases.size} prisma enums; excluded ${excluded.length}:`)
for (const e of excluded) console.log(`  - ${e.name}: ${e.reason}`)
