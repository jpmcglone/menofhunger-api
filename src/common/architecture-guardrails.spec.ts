import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Ratchet guardrails for modularity and DRY.
 *
 * Each rule has a baseline of known offenders in architecture-guardrails.baseline.json.
 * New offenders fail the test. Fixed offenders must be removed from the baseline (the test
 * fails on stale entries), so the lists can only shrink. Regenerate with
 * `UPDATE_GUARDRAIL_BASELINE=1 npx jest src/common/architecture-guardrails.spec.ts` only
 * after fixing offenders, never to admit new ones.
 */

const SRC = join(__dirname, '..');
const BASELINE_PATH = join(__dirname, 'architecture-guardrails.baseline.json');
const MAX_FILE_LINES = 1200;
/** The shared helpers themselves are the one allowed definition. */
const CANONICAL_TEXT_HELPERS = new Set(['common/text/escape-html.ts', 'common/text/slugify.ts']);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

const rel = (f: string) => relative(SRC, f).split(sep).join('/');
const files = walk(SRC);
const read = (f: string) => readFileSync(f, 'utf8');

type RuleResults = Record<string, string[]>;

function computeOffenders(): RuleResults {
  const controllersWithPrisma: string[] = [];
  const postTableOutsidePosts = new Set<string>();
  const oversized: string[] = [];
  const escapeHtmlDefs: string[] = [];
  const slugifyDefs: string[] = [];

  for (const file of files) {
    const path = rel(file);
    const src = read(file);
    if (path.endsWith('.controller.ts') && /this\.prisma\./.test(src)) controllersWithPrisma.push(path);
    if (path.startsWith('modules/') && !path.startsWith('modules/posts/') && /\bprisma\.post\./.test(src)) {
      postTableOutsidePosts.add(path);
    }
    if (src.split('\n').length > MAX_FILE_LINES) oversized.push(path);
    if (!CANONICAL_TEXT_HELPERS.has(path)) {
      if (/function escapeHtml\b|const escapeHtml\b/.test(src)) escapeHtmlDefs.push(path);
      if (/function slugify\w*\(|const slugify\w*\s*=/.test(src)) slugifyDefs.push(path);
    }
  }

  return {
    controllersUsingPrisma: controllersWithPrisma.sort(),
    postTableOutsidePostsModule: [...postTableOutsidePosts].sort(),
    filesOverMaxLines: oversized.sort(),
    duplicateEscapeHtml: escapeHtmlDefs.sort(),
    duplicateSlugify: slugifyDefs.sort(),
  };
}

describe('architecture guardrails (ratchet)', () => {
  const current = computeOffenders();

  if (process.env.UPDATE_GUARDRAIL_BASELINE === '1') {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  }

  const baseline: RuleResults = existsSync(BASELINE_PATH) ? JSON.parse(read(BASELINE_PATH)) : {};

  const messages: Record<string, string> = {
    controllersUsingPrisma: 'Controllers must delegate to services; do not use this.prisma in *.controller.ts.',
    postTableOutsidePostsModule: 'Read posts through the posts module API, not prisma.post outside modules/posts.',
    filesOverMaxLines: `Keep files under ${MAX_FILE_LINES} lines; split by responsibility.`,
    duplicateEscapeHtml: 'Use the shared escapeHtml helper in common/text.',
    duplicateSlugify: 'Use the shared slugify helper in common/text.',
  };

  for (const rule of Object.keys(messages)) {
    it(`${rule}: no new offenders`, () => {
      const allowed = new Set(baseline[rule] ?? []);
      const added = (current[rule] ?? []).filter((f) => !allowed.has(f));
      if (added.length) throw new Error(`${messages[rule]}\n${added.join('\n')}`);
    });

    it(`${rule}: baseline has no stale entries`, () => {
      const now = new Set(current[rule] ?? []);
      const stale = (baseline[rule] ?? []).filter((f) => !now.has(f));
      if (stale.length) throw new Error(`Remove fixed files from the baseline:\n${stale.join('\n')}`);
    });
  }
});
