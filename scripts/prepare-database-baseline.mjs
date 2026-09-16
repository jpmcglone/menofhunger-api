import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const hash = value => createHash('sha256').update(value).digest('hex')
const manifest = JSON.parse(readFileSync('test/database-baseline/manifest.json', 'utf8'))
if (hash(readFileSync('test/database-baseline/schema.prisma')) !== manifest.schemaSha256) throw new Error('Baseline schema checksum mismatch')
for (const [name, checksum] of Object.entries(manifest.migrations)) {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error('Invalid migration name')
  if (hash(readFileSync(`prisma/migrations/${name}/migration.sql`)) !== checksum) throw new Error(`Historical migration changed: ${name}`)
}
if (process.argv.includes('--sql')) {
  console.log(`CREATE TABLE "_prisma_migrations" (
    id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz,
    migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz,
    started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0
  );`)
  let index = 0
  for (const [name, checksum] of Object.entries(manifest.migrations)) {
    console.log(`INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at, applied_steps_count) VALUES ('fixture-${index++}', '${checksum}', '${name}', now(), 1);`)
  }
  console.log(`INSERT INTO "User" (id, phone) VALUES ('migration_fixture', '+15550000999');`)
} else {
  console.log(`Verified baseline ${manifest.sourceCommit} (${Object.keys(manifest.migrations).length} historical migrations).`)
}
