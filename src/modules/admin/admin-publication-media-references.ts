import type { PrismaService } from "../prisma/prisma.service";
import type { PublicationRef } from "./admin-image-review.types";
import {
  articleBodyContainsKey,
  matchStoredAssetToKey,
} from "./admin-image-review.references";

/** Retain publication media across drafts, scheduling, and completed email sends. */
export async function resolvePublicationReferences(
  prisma: Pick<PrismaService, "announcement" | "newsletter" | "emailDelivery">,
  keys: string[],
) {
  const refs = new Map(
    keys.map((key) => [
      key,
      {
        announcements: [] as PublicationRef[],
        newsletters: [] as PublicationRef[],
        emailDeliveries: [] as PublicationRef[],
      },
    ]),
  );
  if (!keys.length) return refs;
  const [announcements, newsletters, deliveries] = await Promise.all([
    prisma.announcement.findMany({
      where: { imageKey: { in: keys } },
      select: { id: true, title: true, status: true, imageKey: true },
    }),
    prisma.newsletter.findMany({
      where: {
        OR: [
          { imageKey: { in: keys } },
          ...keys.map((key) => ({ bodyJson: { contains: key } })),
        ],
      },
      select: {
        id: true,
        subject: true,
        status: true,
        imageKey: true,
        bodyJson: true,
      },
    }),
    prisma.emailDelivery.findMany({
      where: { mediaUrls: { isEmpty: false } },
      select: { id: true, status: true, mediaUrls: true },
    }),
  ]);
  for (const row of deliveries) {
    for (const key of keys) {
      const keySet = new Set([key]);
      const urlMap = new Map<string, string>();
      const used = row.mediaUrls.some(
        (url) => matchStoredAssetToKey(url, keySet, urlMap) === key,
      );
      if (used)
        refs.get(key)!.emailDeliveries.push({
          id: row.id,
          title: "Retained email image",
          status: row.status,
          isInline: true,
        });
    }
  }
  for (const row of announcements) {
    if (row.imageKey)
      refs.get(row.imageKey)?.announcements.push({
        id: row.id,
        title: row.title,
        status: row.status,
        isInline: false,
      });
  }
  for (const row of newsletters) {
    for (const key of keys) {
      const cover = row.imageKey === key;
      const inline = articleBodyContainsKey(row.bodyJson, key);
      if (cover || inline)
        refs.get(key)!.newsletters.push({
          id: row.id,
          title: row.subject,
          status: row.status,
          isInline: !cover,
        });
    }
  }
  return refs;
}
