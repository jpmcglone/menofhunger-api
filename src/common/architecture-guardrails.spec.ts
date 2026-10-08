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
const MAX_FILE_LINES = 900;
/** Files above this size may not grow (ratchet); files above MAX_FILE_LINES are listed as offenders. */
const GROWTH_WATCH_LINES = 800;
/** The shared helpers themselves are the one allowed definition. */
const CANONICAL_TEXT_HELPERS = new Set(['common/text/escape-html.ts', 'common/text/slugify.ts']);
/** Small helpers with exactly one allowed definition (name -> canonical file). */
const CANONICAL_SMALL_HELPERS: Record<string, string> = {
  normalizeTag: 'common/text/normalize.ts',
  normalizeCommentBody: 'common/text/normalize.ts',
  clampInt: 'common/numbers/clamp.ts',
  chunk: 'common/arrays/chunk.ts',
  toIsoOrNull: 'common/time/to-iso.ts',
  uniqueStrings: 'common/arrays/unique-strings.ts',
};
/** Services that own group/crew membership rows. Everything else must go through them. */
const MEMBERSHIP_OWNERS = /^modules\/(groups|crew|group-channels|viewer)\//;

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

/** Resolve `@Module({ imports })` by class name (not directory) and report strongly connected components > 1. */
function findModuleCycles(): string[] {
  const moduleFiles = files.filter((f) => f.endsWith('.module.ts'));
  const known = new Set<string>();
  const sources = new Map<string, string>();
  for (const f of moduleFiles) {
    const src = read(f);
    for (const m of src.matchAll(/export class (\w+)/g)) {
      known.add(m[1]);
      sources.set(m[1], src);
    }
  }
  const graph = new Map<string, string[]>();
  for (const [name, src] of sources) {
    const block = src.match(/@Module\(\{[\s\S]*?imports:\s*\[([\s\S]*?)\]/);
    const deps = block ? [...block[1].matchAll(/\b([A-Z]\w*Module)\b/g)].map((m) => m[1]).filter((d) => known.has(d) && d !== name) : [];
    graph.set(name, [...new Set(deps)]);
  }
  let index = 0;
  const stack: string[] = [];
  const on = new Set<string>();
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const cycles: string[] = [];
  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) cycles.push(comp.sort().join(' <-> '));
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  return cycles.sort();
}

function computeOffenders(): RuleResults {
  const controllersWithPrisma: string[] = [];
  const postTableOutsidePosts = new Set<string>();
  const oversized: string[] = [];
  const escapeHtmlDefs: string[] = [];
  const slugifyDefs: string[] = [];
  const moduleRefGet: string[] = [];
  const forwardRefs: string[] = [];
  const inlineUserBrief: string[] = [];
  const handRolledCursor: string[] = [];
  const adHocCursorSchema: string[] = [];
  const smallHelperDefs: string[] = [];
  const membershipOutside: string[] = [];
  const deepImports: string[] = [];
  const growthWatch: string[] = [];

  for (const file of files) {
    const path = rel(file);
    const src = read(file);
    if (path.endsWith('.controller.ts') && /this\.prisma\.|PrismaService|\bprisma\./.test(src)) controllersWithPrisma.push(path);
    if (/\.get\(\s*[A-Za-z]+,\s*\{\s*strict:\s*false/.test(src)) moduleRefGet.push(path);
    if (/\bforwardRef\(/.test(src)) forwardRefs.push(path);
    if (path !== 'common/prisma-selects/user.select.ts' && /select:\s*\{\s*id:\s*true,\s*username:\s*true/.test(src)) inlineUserBrief.push(path);
    if (/\.length > (limit|take|pageSize)\b/.test(src) && /\.slice\(0, (limit|take|pageSize)\)/.test(src) && path !== 'common/pagination/page.ts') handRolledCursor.push(path);
    if (!path.startsWith('common/pagination/') && /limit: z\.coerce/.test(src) && /cursor: z\.string\(\)/.test(src)) adHocCursorSchema.push(path);
    for (const [name, home] of Object.entries(CANONICAL_SMALL_HELPERS)) {
      if (path !== home && new RegExp(`(function ${name}\\b|const ${name}\\s*=\\s*(\\(|<|async))`).test(src)) smallHelperDefs.push(`${path}#${name}`);
    }
    if (path.startsWith('modules/') && !MEMBERSHIP_OWNERS.test(path) && /\b(prisma|tx)\.(communityGroupMember|crewMember)\./.test(src)) membershipOutside.push(path);
    if (path.startsWith('modules/')) {
      const own = path.split('/')[1];
      let n = 0;
      for (const m of src.matchAll(/from\s+['"]\.\.\/(?:\.\.\/)?([a-z0-9-]+)\/[^'"]+['"]/g)) {
        const full = m[0];
        const up = full.includes("'../../") || full.includes('"../../');
        if (!up && m[1] !== own && full.split('/').length > 2) n += 1;
      }
      if (n > 0) deepImports.push(`${path}:${n}`);
    }
    {
      const lines = src.split('\n').length;
      if (lines > GROWTH_WATCH_LINES) growthWatch.push(`${path}:${lines}`);
    }
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
    moduleRefGetInProd: moduleRefGet.sort(),
    forwardRefInProd: forwardRefs.sort(),
    inlineUserBriefSelect: inlineUserBrief.sort(),
    handRolledCursorPage: handRolledCursor.sort(),
    adHocCursorSchema: adHocCursorSchema.sort(),
    duplicateSmallHelpers: smallHelperDefs.sort(),
    membershipLookupOutsideAccess: membershipOutside.sort(),
    deepCrossModuleImport: deepImports.sort(),
    filesOverGrowthWatch: growthWatch.sort(),
    moduleImportCycles: findModuleCycles(),
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
    moduleRefGetInProd: 'Inject dependencies through Nest DI; do not resolve with moduleRef.get(..., { strict: false }).',
    forwardRefInProd: 'forwardRef() is forbidden. Break the module cycle instead.',
    inlineUserBriefSelect: 'Use USER_REF_SELECT / USER_BRIEF_SELECT / USER_AVATAR_BRIEF_SELECT from common/prisma-selects.',
    handRolledCursorPage: 'Use toPage() from common/pagination/page instead of hand-rolled take+1 slicing.',
    adHocCursorSchema: 'Use cursorPageQuerySchema() from common/pagination instead of an ad-hoc cursor/limit schema.',
    duplicateSmallHelpers: 'Small helpers have one canonical definition (see CANONICAL_SMALL_HELPERS); import it.',
    membershipLookupOutsideAccess: 'Group/crew membership rows are read through the groups/crew/group-channels/viewer access services.',
    moduleImportCycles: '@Module import cycles are forbidden.',
  };

  const counted: Record<string, string> = {
    deepCrossModuleImport: 'Import from another module through its public barrel/service, not internals; counts may only shrink.',
    filesOverGrowthWatch: `Files over ${GROWTH_WATCH_LINES} lines may not grow; split by responsibility.`,
  };

  it('forwardRefInProd and moduleImportCycles have no baseline', () => {
    expect(current.forwardRefInProd).toEqual([]);
    expect(current.moduleImportCycles).toEqual([]);
  });

  for (const [rule, message] of Object.entries(counted)) {
    const parse = (entries: string[] = []) => new Map(entries.map((e) => [e.slice(0, e.lastIndexOf(':')), Number(e.slice(e.lastIndexOf(':') + 1))]));
    it(`${rule}: counts do not grow`, () => {
      const allowed = parse(baseline[rule]);
      const grown = [...parse(current[rule])].filter(([f, n]) => n > (allowed.get(f) ?? 0));
      if (grown.length) throw new Error(`${message}\n${grown.map(([f, n]) => `${f} (${n} > ${allowed.get(f) ?? 0})`).join('\n')}`);
    });
    it(`${rule}: baseline has no stale entries`, () => {
      const now = parse(current[rule]);
      const stale = [...parse(baseline[rule])].filter(([f, n]) => !now.has(f) || now.get(f)! < n);
      if (stale.length) throw new Error(`Lower or remove fixed entries in the baseline (regenerate):\n${stale.map(([f]) => f).join('\n')}`);
    });
  }

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
