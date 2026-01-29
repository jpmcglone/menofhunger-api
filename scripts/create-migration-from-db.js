/* eslint-disable no-console */
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function pad2(n) {
  return String(n).padStart(2, '0')
}

function timestampUtc() {
  const d = new Date()
  // Use UTC to avoid local timezone surprises.
  return (
    String(d.getUTCFullYear()) +
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate()) +
    pad2(d.getUTCHours()) +
    pad2(d.getUTCMinutes()) +
    pad2(d.getUTCSeconds())
  )
}

function slugify(name) {
  return (name ?? '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function main() {
  const rawName = process.argv.slice(2).join(' ').trim()
  if (!rawName) {
    console.error('Usage: npm run prisma:migrate:create -- <migration_name>')
    process.exit(1)
  }

  const dbUrl = (process.env.DATABASE_URL ?? '').trim()
  if (!dbUrl) {
    console.error('DATABASE_URL is not set (did you load .env?)')
    process.exit(1)
  }

  const ts = timestampUtc()
  const slug = slugify(rawName)
  const folderName = `${ts}_${slug || 'migration'}`
  const migrationsDir = path.join(process.cwd(), 'prisma', 'migrations', folderName)

  const cmd = [
    'npx prisma migrate diff',
    `--from-url "${dbUrl}"`,
    '--to-schema-datamodel prisma/schema.prisma',
    '--script',
  ].join(' ')

  const sql = execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim() + '\n'

  // If there's no diff, don't create an empty migration.
  if (!sql.trim() || sql.trim() === '-- This is an empty migration.') {
    console.log('No schema changes detected; no migration created.')
    return
  }

  fs.mkdirSync(migrationsDir, { recursive: true })
  fs.writeFileSync(path.join(migrationsDir, 'migration.sql'), sql, 'utf8')
  console.log('Created migration:', path.relative(process.cwd(), migrationsDir))
}

main()

