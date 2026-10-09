import { PrismaService } from '../prisma/prisma.service';
import { slugifyCrewHandle } from '../../common/text/slugify';
import { NOT_DELETED } from '../../common/prisma/where';

/** Crew slug sanitizer: lowercase, hyphen-separated, capped at 72 chars before dedup. */
/**
 * Find a unique slug. Considers both the active `Crew.slug` column and the
 * `CrewSlugHistory` table so old slugs cannot collide with new crews and
 * redirects stay coherent.
 */
export async function ensureUniqueCrewSlug(
  prisma: PrismaService,
  baseInput: string,
  opts?: { excludeCrewId?: string | null },
): Promise<string> {
  const base = slugifyCrewHandle(baseInput);
  let n = 0;
  // Hard upper bound to prevent pathological infinite loops in edge cases.
  while (n < 10_000) {
    const candidate = n === 0 ? base : `${base}-${n}`;
    if (candidate.length > 80) {
      // Shrink the base to leave room for the numeric suffix and retry.
      return ensureUniqueCrewSlug(prisma, base.slice(0, 60), opts);
    }
    const [activeHit, historyHit] = await Promise.all([
      prisma.crew.findFirst({
        where: {
          slug: candidate,
          ...NOT_DELETED,
          ...(opts?.excludeCrewId ? { NOT: { id: opts.excludeCrewId } } : {}),
        },
        select: { id: true },
      }),
      prisma.crewSlugHistory.findUnique({
        where: { slug: candidate },
        select: { crewId: true },
      }),
    ]);
    const historyBelongsToExcluded =
      historyHit && opts?.excludeCrewId && historyHit.crewId === opts.excludeCrewId;
    if (!activeHit && (!historyHit || historyBelongsToExcluded)) return candidate;
    n += 1;
  }
  // Extremely defensive fallback — should never happen.
  return `${base}-${Date.now().toString(36)}`;
}
