import { PrismaService } from '../prisma/prisma.service';
import { normalizeTag } from '../../common/text/normalize';

/** Sync tags for an article inside an existing transaction (or the main client). */
export async function syncTags(
  db: PrismaService | Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
  articleId: string,
  rawTags: string[],
) {
  const MAX_TAGS = 10;
  const tags = rawTags
    .map((r) => ({ label: r.trim().substring(0, 50), tag: normalizeTag(r) }))
    .filter((t) => t.tag.length >= 1)
    .slice(0, MAX_TAGS);

  // Delete all existing tags then re-insert — simpler than diffing for N≤10.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await db.articleTag.deleteMany({ where: { articleId } });
  if (tags.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.articleTag.createMany({
      data: tags.map((t) => ({
        id: require('crypto').randomUUID(),
        articleId,
        tag: t.tag,
        label: t.label,
      })),
      skipDuplicates: true,
    });

    // Keep canonical taxonomy in sync with article tag writes.
    for (const t of tags) {
      const alias = t.label.toLowerCase().trim().slice(0, 80);
      if (!alias) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const term = await db.taxonomyTerm.upsert({
        where: { slug: t.tag },
        update: { label: t.label, kind: 'tag', status: 'active' },
        create: { slug: t.tag, label: t.label, kind: 'tag', status: 'active' },
        select: { id: true },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.taxonomyAlias.upsert({
        where: { alias },
        update: { termId: term.id, source: 'article_tag' },
        create: { alias, termId: term.id, source: 'article_tag' },
      });
    }
  }
}
