import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/**
 * Ratchet guardrails for modularity and DRY.
 *
 * Each rule has a baseline of known offenders in architecture-guardrails.baseline.json.
 * New offenders fail the test. Fixed offenders must be removed from the baseline (the test
 * fails on stale entries), so the lists can only shrink. Regenerate with
 * `UPDATE_GUARDRAIL_BASELINE=1 npx jest src/common/architecture-guardrails.spec.ts` only
 * after fixing offenders, never to admit new ones.
 */

const SRC = join(__dirname, "..");
const BASELINE_PATH = join(__dirname, "architecture-guardrails.baseline.json");
const MAX_FILE_LINES = 700;
/** Files above this size may not grow (ratchet); files above MAX_FILE_LINES are listed as offenders. */
const GROWTH_WATCH_LINES = 800;
/** The shared helpers themselves are the one allowed definition. */
const CANONICAL_TEXT_HELPERS = new Set([
  "common/text/escape-html.ts",
  "common/text/slugify.ts",
]);
/** Small helpers with exactly one allowed definition (name -> canonical file). */
const CANONICAL_SMALL_HELPERS: Record<string, string> = {
  normalizeTag: "common/text/normalize.ts",
  normalizeCommentBody: "common/text/normalize.ts",
  clampInt: "common/numbers/clamp.ts",
  chunk: "common/arrays/chunk.ts",
  toIsoOrNull: "common/time/to-iso.ts",
  uniqueStrings: "common/arrays/unique-strings.ts",
};
/** Services that own group/crew membership rows. Everything else must go through them. */
const MEMBERSHIP_OWNERS = /^modules\/(groups|crew|group-channels|viewer)\//;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".spec.ts") &&
      !entry.endsWith(".d.ts")
    )
      acc.push(full);
  }
  return acc;
}

const rel = (f: string) => relative(SRC, f).split(sep).join("/");
const files = walk(SRC);
const read = (f: string) => readFileSync(f, "utf8");

type RuleResults = Record<string, string[]>;

/** Resolve an import specifier relative to `file` to a path under src (no extension), or null. */
function resolveImport(file: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  return relative(SRC, join(dirname(file), spec))
    .split(sep)
    .join("/");
}

const publicFilesCache = new Map<string, Set<string>>();
/** Files a module's barrel re-exports (`export * from './x'`), as src-relative paths without extension. */
function publicFilesOf(moduleName: string): Set<string> {
  const cached = publicFilesCache.get(moduleName);
  if (cached) return cached;
  const barrel = join(SRC, "modules", moduleName, "index.ts");
  const result = new Set<string>();
  if (existsSync(barrel)) {
    for (const m of read(barrel).matchAll(
      /export\s+(?:\*|\{[^}]*\})\s+from\s+['"](\.[^'"]+)['"]/g,
    )) {
      const target = resolveImport(barrel, m[1]);
      if (target) result.add(target);
    }
  }
  publicFilesCache.set(moduleName, result);
  return result;
}

/**
 * Cross-module imports that bypass the target module's public surface. Allowed: the module's barrel
 * (`modules/<m>` or `index`), a file that barrel re-exports, `*.module` files imported from a
 * `*.module.ts`/`main.ts`, and the auth guards entry (`auth/auth-public-api`; auth has no full barrel
 * because it caused load-time cycles). Injected classes should come from the re-exported file itself:
 * under SWC a barrel import inside an import cycle leaves the constructor type `undefined`.
 */
function countDeepCrossModuleImports(
  file: string,
  path: string,
  src: string,
): number {
  const own = path.split("/")[1];
  const isModuleFile = path.endsWith(".module.ts") || path === "main.ts";
  let n = 0;
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g)) {
    const target = resolveImport(file, m[1]);
    if (!target?.startsWith("modules/")) continue;
    const parts = target.split("/");
    if (parts[1] === own || parts.length <= 2 || parts[2] === "index") continue;
    if (target === "modules/auth/auth-public-api") continue;
    if (publicFilesOf(parts[1]).has(target)) continue;
    if (isModuleFile && parts[parts.length - 1].endsWith(".module")) continue;
    n += 1;
  }
  return n;
}

/** Resolve `@Module({ imports })` by class name (not directory) and report strongly connected components > 1. */
function findModuleCycles(): string[] {
  const moduleFiles = files.filter((f) => f.endsWith(".module.ts"));
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
    const deps = block
      ? [...block[1].matchAll(/\b([A-Z]\w*Module)\b/g)]
          .map((m) => m[1])
          .filter((d) => known.has(d) && d !== name)
      : [];
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
      if (comp.length > 1) cycles.push(comp.sort().join(" <-> "));
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
  const inlineGroupSelect: string[] = [];
  const handRolledCursor: string[] = [];
  const adHocCursorSchema: string[] = [];
  const smallHelperDefs: string[] = [];
  const membershipOutside: string[] = [];
  const deepImports: string[] = [];
  const asAnyCasts: string[] = [];
  const asUnknownCasts: string[] = [];
  const hostParameters: string[] = [];
  const prismaCodeLiterals: string[] = [];
  const inlineLimitClamps: string[] = [];
  const bannedAtLiterals: string[] = [];
  const publicConstructorDeps: string[] = [];
  const growthWatch: string[] = [];
  const limitPlusOne: string[] = [];
  const jsonCursors: string[] = [];
  const inlineDeletedAt: string[] = [];
  const controllerZodObjects: string[] = [];
  const passThroughForwards: string[] = [];
  const optionalCtorParams: string[] = [];
  const ctorFallbackNew: string[] = [];
  const duplicatedViewerBlockCache: string[] = [];
  const rawPostDelegates: string[] = [];
  const broadDomainFacadeImports: string[] = [];
  const productionTestImports: string[] = [];
  const privatePostWriteExports: string[] = [];

  for (const file of files) {
    const path = rel(file);
    const src = read(file);
    if (!path.endsWith(".testing.ts")) {
      if (
        /\bimport\s+(?:type\s+)?(?:\{[^}]*\b(?:PostsService|MessagesService|NotificationsService)\b[^}]*\}|(?:PostsService|MessagesService|NotificationsService))\s+from\s*['"][^'"]+['"]/.test(
          src,
        )
      )
        broadDomainFacadeImports.push(path);
      if (/from\s*['"][^'"]+\.testing['"]/.test(src))
        productionTestImports.push(path);
    }
    if (
      path === "modules/posts/index.ts" &&
      /from\s*['"]\.\/posts-(?:write-authorization\.service|write-persistence\.service|board-write\.policy|checkin-write\.service|quote-write\.service)['"]/.test(
        src,
      )
    )
      privatePostWriteExports.push(path);
    if (
      path !== "modules/viewer/viewer-block-sets.service.ts" &&
      /RedisKeys\.viewerBlockSets\(/.test(src)
    )
      duplicatedViewerBlockCache.push(path);
    if (
      path.startsWith("modules/posts-read/") &&
      /return this\.prisma\.post\s*;|export type Post(?:Read|Write)Delegate/.test(
        src,
      )
    )
      rawPostDelegates.push(path);
    if (
      path.endsWith(".controller.ts") &&
      /this\.prisma\.|PrismaService|\bprisma\./.test(src)
    )
      controllersWithPrisma.push(path);
    if (/\.get\(\s*[A-Za-z]+,\s*\{\s*strict:\s*false/.test(src))
      moduleRefGet.push(path);
    if (/\bforwardRef\(/.test(src)) forwardRefs.push(path);
    if (
      path !== "common/prisma-selects/group.select.ts" &&
      /select:\s*\{\s*id:\s*true,\s*slug:\s*true,\s*name:\s*true,?(?:\s*avatarImageUrl:\s*true,?)?(?:\s*coverImageUrl:\s*true,?)?\s*\}/.test(
        src,
      )
    )
      inlineGroupSelect.push(path);
    if (
      path !== "common/prisma-selects/user.select.ts" &&
      /select:\s*\{\s*id:\s*true,\s*username:\s*true(?:,\s*name:\s*true)?,?\s*\}/.test(
        src,
      )
    )
      inlineUserBrief.push(path);
    if (
      /\.length > (limit|take|pageSize)\b/.test(src) &&
      /\.slice\(0, (limit|take|pageSize)\)/.test(src) &&
      path !== "common/pagination/page.ts"
    )
      handRolledCursor.push(path);
    if (
      !path.startsWith("common/pagination/") &&
      /limit: z\.coerce/.test(src) &&
      /cursor: z\.string\(\)/.test(src)
    )
      adHocCursorSchema.push(path);
    for (const [name, home] of Object.entries(CANONICAL_SMALL_HELPERS)) {
      if (
        path !== home &&
        new RegExp(
          `(function ${name}\\b|const ${name}\\s*=\\s*(\\(|<|async))`,
        ).test(src)
      )
        smallHelperDefs.push(`${path}#${name}`);
    }
    if (
      path.startsWith("modules/") &&
      !MEMBERSHIP_OWNERS.test(path) &&
      /\b(prisma|tx)\.(communityGroupMember|crewMember)\./.test(src)
    )
      membershipOutside.push(path);
    if (path.startsWith("modules/")) {
      const deep = countDeepCrossModuleImports(file, path, src);
      if (deep > 0) deepImports.push(`${path}:${deep}`);
    }
    const counted = (re: RegExp, bucket: string[], skip = false) => {
      if (skip) return;
      const n = (src.match(re) ?? []).length;
      if (n > 0) bucket.push(`${path}:${n}`);
    };
    counted(/\bas any\b/g, asAnyCasts, path.endsWith(".d.ts"));
    counted(/\bas unknown as\b/g, asUnknownCasts);
    counted(
      /\bhost: [A-Z]\w*(?:Service|Handler|Controller|Processor)\b/g,
      hostParameters,
    );
    counted(
      /\bcode\s*[=!]==?\s*['"]P20(?:02|25)['"]/g,
      prismaCodeLiterals,
      path === "common/prisma/errors.ts",
    );
    counted(
      /Math\.max\(1,\s*Math\.min\(/g,
      inlineLimitClamps,
      path === "common/pagination/page.ts",
    );
    counted(
      /\bbannedAt:\s*null\b/g,
      bannedAtLiterals,
      path === "common/prisma-selects/user.where.ts",
    );
    counted(/\blimit \+ 1\b|\btake:\s*[\w.]+\s*\+\s*1\b/g, limitPlusOne);
    counted(
      /Buffer\.from\(JSON\.stringify\(|JSON\.parse\(Buffer\.from\(/g,
      jsonCursors,
      path === "common/pagination/json-cursor.ts",
    );
    counted(
      /\bdeletedAt:\s*null\b/g,
      inlineDeletedAt,
      path === "common/prisma/where.ts",
    );
    counted(
      /\bz\.object\(/g,
      controllerZodObjects,
      !path.endsWith(".controller.ts"),
    );
    counted(/\.\.\.args: Parameters</g, passThroughForwards);
    counted(/@Optional\(\)/g, optionalCtorParams);
    counted(
      /\?\?\s*new\s+[A-Z]\w*(?:Service|Handler|Cron|Processor)\b/g,
      ctorFallbackNew,
    );
    if (
      path.endsWith(".service.ts") ||
      path.endsWith(".handler.ts") ||
      path.endsWith(".processor.ts")
    ) {
      const ctor = src.match(/constructor\(([\s\S]*?)\)\s*\{/);
      const n = ctor
        ? (ctor[1].match(/^\s+(?:@\w+\([^)]*\)\s+)?readonly \w+\??:/gm) ?? [])
            .length
        : 0;
      if (n > 0) publicConstructorDeps.push(`${path}:${n}`);
    }
    {
      const lines = src.split("\n").length;
      if (lines > GROWTH_WATCH_LINES) growthWatch.push(`${path}:${lines}`);
    }
    if (
      path.startsWith("modules/") &&
      !/^modules\/(posts|posts-read)\//.test(path) &&
      /\b(?:prisma|tx)\.post\./.test(src)
    ) {
      postTableOutsidePosts.add(path);
    }
    if (src.split("\n").length > MAX_FILE_LINES) oversized.push(path);
    if (!CANONICAL_TEXT_HELPERS.has(path)) {
      if (/function escapeHtml\b|const escapeHtml\b/.test(src))
        escapeHtmlDefs.push(path);
      if (/function slugify\w*\(|const slugify\w*\s*=/.test(src))
        slugifyDefs.push(path);
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
    inlineGroupSelect: inlineGroupSelect.sort(),
    handRolledCursorPage: handRolledCursor.sort(),
    adHocCursorSchema: adHocCursorSchema.sort(),
    duplicateSmallHelpers: smallHelperDefs.sort(),
    membershipLookupOutsideAccess: membershipOutside.sort(),
    deepCrossModuleImport: deepImports.sort(),
    asAnyCasts: asAnyCasts.sort(),
    asUnknownCasts: asUnknownCasts.sort(),
    hostParameterFunctions: hostParameters.sort(),
    prismaErrorCodeLiterals: prismaCodeLiterals.sort(),
    inlineLimitClamps: inlineLimitClamps.sort(),
    bannedAtLiterals: bannedAtLiterals.sort(),
    publicConstructorDeps: publicConstructorDeps.sort(),
    filesOverGrowthWatch: growthWatch.sort(),
    limitPlusOneFetches: limitPlusOne.sort(),
    handRolledJsonCursors: jsonCursors.sort(),
    inlineDeletedAtNull: inlineDeletedAt.sort(),
    controllerInlineZodObjects: controllerZodObjects.sort(),
    passThroughForwarders: passThroughForwards.sort(),
    optionalConstructorParams: optionalCtorParams.sort(),
    constructorFallbackNew: ctorFallbackNew.sort(),
    moduleImportCycles: findModuleCycles(),
    duplicatedViewerBlockCache: duplicatedViewerBlockCache.sort(),
    rawPostDelegates: rawPostDelegates.sort(),
    broadDomainFacadeImports: broadDomainFacadeImports.sort(),
    productionTestImports: productionTestImports.sort(),
    privatePostWriteExports: privatePostWriteExports.sort(),
  };
}

describe("architecture guardrails (ratchet)", () => {
  const current = computeOffenders();

  if (process.env.UPDATE_GUARDRAIL_BASELINE === "1") {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  }

  const baseline: RuleResults = existsSync(BASELINE_PATH)
    ? JSON.parse(read(BASELINE_PATH))
    : {};

  const messages: Record<string, string> = {
    controllersUsingPrisma:
      "Controllers must delegate to services; do not use this.prisma in *.controller.ts.",
    postTableOutsidePostsModule:
      "Read posts through the posts module API, not prisma.post or tx.post outside the posts ownership modules.",
    filesOverMaxLines: `Keep files under ${MAX_FILE_LINES} lines; split by responsibility.`,
    duplicateEscapeHtml: "Use the shared escapeHtml helper in common/text.",
    duplicateSlugify: "Use the shared slugify helper in common/text.",
    moduleRefGetInProd:
      "Inject dependencies through Nest DI; do not resolve with moduleRef.get(..., { strict: false }).",
    forwardRefInProd:
      "forwardRef() is forbidden. Break the module cycle instead.",
    inlineUserBriefSelect:
      "Use USER_REF_SELECT / USER_BRIEF_SELECT / USER_AVATAR_BRIEF_SELECT from common/prisma-selects.",
    inlineGroupSelect:
      "Use GROUP_REF_SELECT / GROUP_CARD_SELECT / GROUP_MEDIA_SELECT from common/prisma-selects/group.select.",
    handRolledCursorPage:
      "Use toPage() from common/pagination/page instead of hand-rolled take+1 slicing.",
    adHocCursorSchema:
      "Use cursorPageQuerySchema() from common/pagination instead of an ad-hoc cursor/limit schema.",
    duplicateSmallHelpers:
      "Small helpers have one canonical definition (see CANONICAL_SMALL_HELPERS); import it.",
    membershipLookupOutsideAccess:
      "Group/crew membership rows are read through the groups/crew/group-channels/viewer access services.",
    moduleImportCycles: "@Module import cycles are forbidden.",
    duplicatedViewerBlockCache:
      "Viewer block-set queries/cache ownership belongs to ViewerBlockSetsService.",
    broadDomainFacadeImports:
      "Consumers depend on focused domain capabilities, not the removed broad Posts/Messages/Notifications facades.",
    productionTestImports:
      "Production code cannot depend on test-only composition helpers.",
    privatePostWriteExports:
      "Authorization and transactional publication collaborators are internal to the posts module.",
    rawPostDelegates:
      "Post boundaries expose policy-enforcing reads and fixed-field write commands, never raw delegates.",
  };

  const counted: Record<string, string> = {
    deepCrossModuleImport:
      "Import from another module through its public barrel (index.ts) or a file it re-exports, not internals. Module files may import other *.module files; auth exposes only its guards via auth/auth-public-api. counts may only shrink.",
    asAnyCasts:
      "Do not add `as any`; type the value (narrow, add a select/mapper type, or use unknown + a guard). Counts may only shrink.",
    asUnknownCasts:
      "Do not add `as unknown as`; fix the type mismatch at the source. Counts may only shrink.",
    hostParameterFunctions:
      "Do not pass a whole service as `host`; inject a collaborator service or pass the specific values. Counts may only shrink.",
    prismaErrorCodeLiterals:
      "Use isUniqueViolation/isNotFound from common/prisma/errors instead of comparing P2002/P2025 codes. Counts may only shrink.",
    inlineLimitClamps:
      "Use clampLimit() from common/pagination/page instead of Math.max(1, Math.min(...)). Counts may only shrink.",
    bannedAtLiterals:
      "Use NOT_BANNED_USER_WHERE from common/prisma-selects/user.where instead of `bannedAt: null`. Counts may only shrink.",
    publicConstructorDeps:
      "Constructor dependencies stay private; extract a collaborator instead of exposing a service internals. Counts may only shrink.",
    filesOverGrowthWatch: `Files over ${GROWTH_WATCH_LINES} lines may not grow; split by responsibility.`,
    limitPlusOneFetches:
      "Fetch pages with toPage()/clampLimit() from common/pagination/page; a `limit + 1` fetch belongs with the toPage() that consumes it. Counts may only shrink.",
    handRolledJsonCursors:
      "Use encodeJsonCursor/decodeJsonCursor from common/pagination/json-cursor instead of hand-rolled base64 JSON cursors. Counts may only shrink.",
    inlineDeletedAtNull:
      "Spread NOT_DELETED from common/prisma/where instead of writing `deletedAt: null`. Counts may only shrink.",
    controllerInlineZodObjects:
      "Define request schemas in the module `*.schemas.ts`, not with z.object() inside a controller. Counts may only shrink.",
    passThroughForwarders:
      "Do not add `(...args: Parameters<X[m]>)` pass-through methods; inject the collaborator and call it directly. Counts may only shrink.",
    optionalConstructorParams:
      "@Optional() is for genuinely optional integrations only; wire required collaborators through the module. Counts may only shrink.",
    constructorFallbackNew:
      "Do not fall back to `?? new Service(...)` in a constructor; inject through Nest DI and build test graphs in *.testing.ts. Counts may only shrink.",
  };

  it("forwardRefInProd and moduleImportCycles have no baseline", () => {
    expect(current.forwardRefInProd).toEqual([]);
    expect(current.moduleImportCycles).toEqual([]);
  });

  for (const [rule, message] of Object.entries(counted)) {
    const parse = (entries: string[] = []) =>
      new Map(
        entries.map((e) => [
          e.slice(0, e.lastIndexOf(":")),
          Number(e.slice(e.lastIndexOf(":") + 1)),
        ]),
      );
    it(`${rule}: counts do not grow`, () => {
      const allowed = parse(baseline[rule]);
      const grown = [...parse(current[rule])].filter(
        ([f, n]) => n > (allowed.get(f) ?? 0),
      );
      if (grown.length)
        throw new Error(
          `${message}\n${grown.map(([f, n]) => `${f} (${n} > ${allowed.get(f) ?? 0})`).join("\n")}`,
        );
    });
    it(`${rule}: baseline has no stale entries`, () => {
      const now = parse(current[rule]);
      const stale = [...parse(baseline[rule])].filter(
        ([f, n]) => !now.has(f) || now.get(f)! < n,
      );
      if (stale.length)
        throw new Error(
          `Lower or remove fixed entries in the baseline (regenerate):\n${stale.map(([f]) => f).join("\n")}`,
        );
    });
  }

  for (const rule of Object.keys(messages)) {
    it(`${rule}: no new offenders`, () => {
      const allowed = new Set(baseline[rule] ?? []);
      const added = (current[rule] ?? []).filter((f) => !allowed.has(f));
      if (added.length)
        throw new Error(`${messages[rule]}\n${added.join("\n")}`);
    });

    it(`${rule}: baseline has no stale entries`, () => {
      const now = new Set(current[rule] ?? []);
      const stale = (baseline[rule] ?? []).filter((f) => !now.has(f));
      if (stale.length)
        throw new Error(
          `Remove fixed files from the baseline:\n${stale.join("\n")}`,
        );
    });
  }
});
