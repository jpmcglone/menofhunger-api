import type { PrismaService } from "../prisma/prisma.service";

type MediaKeys = { r2Key: string | null; thumbnailR2Key: string | null };
type MessageMediaKeys = {
  media?: MediaKeys[];
  replyTo?: { media?: MediaKeys[] } | null;
};

/** Resolve the authoritative tombstone once for an HTTP page or realtime fan-out. */
export async function messageMediaDeletedAt(
  prisma: Pick<PrismaService, "mediaAsset">,
  messages: MessageMediaKeys[],
): Promise<Map<string, Date>> {
  const keys = [
    ...new Set(
      messages.flatMap((message) =>
        [...(message.media ?? []), ...(message.replyTo?.media ?? [])]
          .flatMap((media) => [media.r2Key, media.thumbnailR2Key])
          .filter((key): key is string => Boolean(key)),
      ),
    ),
  ];
  if (!keys.length) return new Map();
  const assets = await prisma.mediaAsset.findMany({
    where: {
      r2Key: { in: keys },
      OR: [{ deletedAt: { not: null } }, { r2DeletedAt: { not: null } }],
    },
    select: { r2Key: true, deletedAt: true, r2DeletedAt: true },
  });
  return new Map(
    assets.flatMap((asset) => {
      const deletedAt = asset.deletedAt ?? asset.r2DeletedAt;
      return deletedAt ? [[asset.r2Key, deletedAt] as const] : [];
    }),
  );
}
