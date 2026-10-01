import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
const web = resolve('../menofhunger-www')
if (!existsSync(web)) { console.log('Sibling web checkout unavailable; public-doc mirror check skipped.'); process.exit(0) }
for (const [source, destination] of [
  ['docs/partners/pickax.md', 'content/developers/partner-guide.md'],
  ['examples/partner/client.mts', 'public/developers/client.mts.txt'],
  ['examples/partner/README.md', 'public/developers/example-readme.txt'],
]) {
  const target = resolve(web, destination), content = readFileSync(source, 'utf8')
  if (process.argv.includes('--check')) {
    if (!existsSync(target) || readFileSync(target, 'utf8') !== content) throw new Error(`Partner docs drift: ${destination}`)
  } else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content) }
}
console.log('Partner guide and runnable example public copies are synchronized.')
