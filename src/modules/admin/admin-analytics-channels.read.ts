import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type {
  AdminAnalyticsChannelsDto,
  AnalyticsGranularity,
} from "../../common/dto/admin-analytics.dto";

/** Live channel messages by people (bots excluded) in non-archived channels. */
const humanMessages = Prisma.sql`
  FROM "Message" m
  JOIN "GroupChannel" gc ON gc."conversationId" = m."conversationId" AND gc."archivedAt" IS NULL
  JOIN "CommunityGroup" g ON g.id = gc."groupId"
  JOIN "User" u ON u.id = m."senderId" AND u."isBot" = false
  WHERE m."deletedForAll" = false
`;

export async function readChannelsAnalytics(
  prisma: PrismaService,
  opts: { since: Date | null; granularity: AnalyticsGranularity },
): Promise<AdminAnalyticsChannelsDto> {
  const { since, granularity } = opts;
  const after = (col: Prisma.Sql) =>
    since ? Prisma.sql`AND ${col} >= ${since}::timestamptz` : Prisma.sql``;

  const [totalsRaw, summaryRaw, marvRaw, mentionsRaw, uploadsRaw, readersRaw, seriesRaw, topRaw] =
    await Promise.all([
      prisma.$queryRaw<
        Array<{ active: bigint; private_count: bigint; groups_with: bigint }>
      >(Prisma.sql`
        SELECT COUNT(*)::bigint AS active,
               COUNT(*) FILTER (WHERE "privacy" = 'private')::bigint AS private_count,
               COUNT(DISTINCT "groupId")::bigint AS groups_with
        FROM "GroupChannel"
        WHERE "archivedAt" IS NULL
      `),
      prisma.$queryRaw<
        Array<{ messages: bigint; thread_replies: bigint; senders: bigint; channels: bigint }>
      >(Prisma.sql`
        SELECT COUNT(*)::bigint AS messages,
               COUNT(*) FILTER (WHERE m."threadRootId" IS NOT NULL)::bigint AS thread_replies,
               COUNT(DISTINCT m."senderId")::bigint AS senders,
               COUNT(DISTINCT gc.id)::bigint AS channels
        ${humanMessages}
          ${after(Prisma.sql`m."createdAt"`)}
      `),
      prisma.$queryRaw<Array<{ cnt: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS cnt
        FROM "Message" m
        JOIN "GroupChannel" gc ON gc."conversationId" = m."conversationId"
        JOIN "User" u ON u.id = m."senderId" AND u."isBot" = true
        WHERE m."deletedForAll" = false
          ${after(Prisma.sql`m."createdAt"`)}
      `),
      prisma.$queryRaw<Array<{ cnt: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS cnt
        FROM "GroupChannelAttention"
        WHERE "mentioned" = true
          ${after(Prisma.sql`"createdAt"`)}
      `),
      prisma.$queryRaw<Array<{ cnt: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS cnt
        FROM "GroupChannelUpload"
        WHERE "consumedAt" IS NOT NULL
          ${after(Prisma.sql`"consumedAt"`)}
      `),
      prisma.$queryRaw<Array<{ cnt: bigint }>>(Prisma.sql`
        SELECT COUNT(DISTINCT "userId")::bigint AS cnt
        FROM "GroupChannelViewerState"
        WHERE true
          ${after(Prisma.sql`"updatedAt"`)}
      `),
      prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>(Prisma.sql`
        SELECT DATE_TRUNC(${granularity}, m."createdAt") AS bucket, COUNT(*)::bigint AS count
        ${humanMessages}
          ${after(Prisma.sql`m."createdAt"`)}
        GROUP BY 1 ORDER BY 1
      `),
      prisma.$queryRaw<
        Array<{
          id: string;
          slug: string;
          group_name: string;
          channel_name: string;
          is_private: boolean;
          messages: bigint;
          senders: bigint;
        }>
      >(Prisma.sql`
        SELECT gc.id, g.slug, g.name AS group_name, gc.name AS channel_name,
               (gc."privacy" = 'private') AS is_private,
               COUNT(*)::bigint AS messages,
               COUNT(DISTINCT m."senderId")::bigint AS senders
        ${humanMessages}
          ${after(Prisma.sql`m."createdAt"`)}
        GROUP BY gc.id, g.slug, g.name, gc.name, gc."privacy"
        ORDER BY messages DESC
        LIMIT 10
      `),
    ]);

  const totals = totalsRaw[0];
  const summary = summaryRaw[0];

  return {
    activeChannels: Number(totals?.active ?? 0),
    privateChannels: Number(totals?.private_count ?? 0),
    groupsWithChannels: Number(totals?.groups_with ?? 0),
    messagesInRange: Number(summary?.messages ?? 0),
    threadRepliesInRange: Number(summary?.thread_replies ?? 0),
    marvRepliesInRange: Number(marvRaw[0]?.cnt ?? 0),
    mentionsInRange: Number(mentionsRaw[0]?.cnt ?? 0),
    uploadsInRange: Number(uploadsRaw[0]?.cnt ?? 0),
    sendersInRange: Number(summary?.senders ?? 0),
    readersInRange: Number(readersRaw[0]?.cnt ?? 0),
    channelsWithActivityInRange: Number(summary?.channels ?? 0),
    messages: seriesRaw.map((r) => ({
      bucket: r.bucket.toISOString().split("T")[0]!,
      count: Number(r.count),
    })),
    topChannels: topRaw.map((r) => ({
      id: r.id,
      groupSlug: r.slug,
      groupName: r.group_name,
      channelName: r.channel_name,
      isPrivate: r.is_private,
      messagesInRange: Number(r.messages),
      sendersInRange: Number(r.senders),
    })),
  };
}
