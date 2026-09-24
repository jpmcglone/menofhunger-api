#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { delimiter } from 'node:path'

const env = { ...process.env }
// Homebrew's minimal ffmpeg omits zscale, required for phone HDR uploads.
// Prefer the separately installed full build for this check only.
if (process.platform === 'darwin') {
  const full = ['/opt/homebrew/opt/ffmpeg-full/bin', '/usr/local/opt/ffmpeg-full/bin']
    .find(path => existsSync(`${path}/ffmpeg`))
  if (full) env.PATH = `${full}${delimiter}${env.PATH}`
}
const filters = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { env, encoding: 'utf8' })
if (filters.status !== 0 || !filters.stdout?.includes('zscale')) {
  console.error('Local checks require ffmpeg with zscale. On macOS: brew install ffmpeg-full')
  process.exit(1)
}
for (const script of ['check:guidance', 'check:env-docs', 'lint', 'build:typecheck', 'check:contracts', 'build', 'test:ci', 'test:e2e', 'mcp:test', 'check:database']) {
  const result = spawnSync('npm', ['run', script], { env, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
