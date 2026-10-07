import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { AppConfigService } from '../app/app-config.service';
import { MessagesService } from '../messages/messages.service';
import { PostsReadService } from '../posts-read/posts-read.service';

@Injectable()
export class NotificationsEmailSupportService {
  readonly logger = new Logger(NotificationsEmailSupportService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly appConfig: AppConfigService,
    private readonly messages: MessagesService,
    private readonly postsRead: PostsReadService,
  ) {}
  private notificationsFromAddress(): string | undefined {
    return this.appConfig.email()?.fromEmail.notifications ?? undefined;
  }

  async sendEmailAndHandle(params: {
    to: string;
    subject: string;
    text: string;
    html: string;
    userId: string;
    logTag: string;
    onSent?: () => Promise<void>;
  }): Promise<void> {
    const sent = await this.email.sendText({
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
      from: this.notificationsFromAddress(),
      category: 'engagement',
      userId: params.userId,
    });

    if (sent.sent) {
      if (params.onSent) await params.onSent();
      return;
    }

    this.logger.debug(`[${params.logTag}] not sent to userId=${params.userId} reason=${sent.reason ?? 'unknown'}`);
  }

  /**
   * Returns the top 3 emailable notifications per recipient — those the user has not yet
   * seen in any form (deliveredAt, readAt, and presentAt all null). Includes
   * community_group_post rows so offline group members receive email nudges.
   */
  async listRecentNotificationItemsByRecipientIds(
    recipientIdsRaw: string[],
  ): Promise<Map<string, Array<{ title: string | null; body: string | null; subjectPostId: string | null }>>> {
    const ids = Array.from(new Set((recipientIdsRaw ?? []).map((x) => String(x ?? '').trim()).filter(Boolean)));
    if (ids.length === 0) return new Map();

    const values = ids.map((id) => Prisma.sql`(${id})`);
    const rows = await this.prisma.$queryRaw<
      Array<{
        recipientUserId: string;
        title: string | null;
        body: string | null;
        subjectPostId: string | null;
      }>
    >(Prisma.sql`
      WITH u("userId") AS (VALUES ${Prisma.join(values)}),
      ranked AS (
        SELECT
          n."recipientUserId" as "recipientUserId",
          n."title" as "title",
          n."body" as "body",
          n."subjectPostId" as "subjectPostId",
          ROW_NUMBER() OVER (
            PARTITION BY n."recipientUserId"
            ORDER BY n."createdAt" DESC, n."id" DESC
          ) as rn
        FROM "Notification" n
        INNER JOIN u ON u."userId" = n."recipientUserId"
        WHERE
          n."deliveredAt" IS NULL
          AND n."readAt" IS NULL
          AND n."presentAt" IS NULL
          AND n."kind" NOT IN ('message', 'word_of_the_day', 'quote_of_the_day')
          AND (n."kind" != 'community_group_post' OR EXISTS (
            SELECT 1 FROM "CommunityGroupMember" gm
            WHERE gm."groupId" = n."subjectGroupId" AND gm."userId" = n."recipientUserId"
              AND gm."status" = 'active' AND gm."notificationPreference" = 'all'
          ))
      )
      SELECT "recipientUserId", "title", "body", "subjectPostId"
      FROM ranked
      WHERE rn <= 3
      ORDER BY "recipientUserId" ASC, rn ASC
    `);

    const out = new Map<string, Array<{ title: string | null; body: string | null; subjectPostId: string | null }>>();
    for (const r of rows) {
      const uid = String(r?.recipientUserId ?? '').trim();
      if (!uid) continue;
      const list = out.get(uid) ?? [];
      list.push({
        title: r?.title ?? null,
        body: r?.body ?? null,
        subjectPostId: r?.subjectPostId ?? null,
      });
      out.set(uid, list);
    }
    return out;
  }

  /**
   * Returns the count of truly "emailable" notifications per recipient: those with
   * deliveredAt, readAt, and presentAt all null (user hasn't opened the bell, tapped
   * through, or been actively present when it arrived). Includes community_group_post
   * so offline group members are counted toward the nudge threshold.
   */
  async listEmailableNotificationCountsByRecipientIds(
    recipientIdsRaw: string[],
  ): Promise<Map<string, number>> {
    const ids = Array.from(new Set((recipientIdsRaw ?? []).map((x) => String(x ?? '').trim()).filter(Boolean)));
    if (ids.length === 0) return new Map();

    const values = ids.map((id) => Prisma.sql`(${id})`);
    const rows = await this.prisma.$queryRaw<Array<{ recipientUserId: string; count: number }>>(
      Prisma.sql`
        WITH u("userId") AS (VALUES ${Prisma.join(values)})
        SELECT
          n."recipientUserId" as "recipientUserId",
          CAST(COUNT(n."id") AS INT) as "count"
        FROM "Notification" n
        INNER JOIN u ON u."userId" = n."recipientUserId"
        WHERE
          n."deliveredAt" IS NULL
          AND n."readAt" IS NULL
          AND n."presentAt" IS NULL
          AND n."kind" NOT IN ('message', 'word_of_the_day', 'quote_of_the_day')
          AND (n."kind" != 'community_group_post' OR EXISTS (
            SELECT 1 FROM "CommunityGroupMember" gm
            WHERE gm."groupId" = n."subjectGroupId" AND gm."userId" = n."recipientUserId"
              AND gm."status" = 'active' AND gm."notificationPreference" = 'all'
          ))
        GROUP BY n."recipientUserId"
      `,
    );

    const out = new Map<string, number>();
    for (const r of rows) {
      const uid = String(r?.recipientUserId ?? '').trim();
      if (!uid) continue;
      out.set(uid, Math.max(0, Math.floor(r?.count ?? 0)));
    }
    return out;
  }

  async getUnreadChatTotalsByUserIds(userIdsRaw: string[]): Promise<Map<string, number>> {
    const ids = Array.from(new Set((userIdsRaw ?? []).map((x) => String(x ?? '').trim()).filter(Boolean)));
    if (ids.length === 0) return new Map();

    const values = ids.map((id) => Prisma.sql`(${id})`);
    const rows = await this.prisma.$queryRaw<
      Array<{ userId: string; status: string; count: number }>
    >(Prisma.sql`
      WITH u("userId") AS (VALUES ${Prisma.join(values)})
      SELECT
        mp."userId" as "userId",
        mp."status" as "status",
        CAST(COUNT(m."id") AS INT) as "count"
      FROM "MessageParticipant" mp
      INNER JOIN u ON u."userId" = mp."userId"
      LEFT JOIN "Message" m
        ON m."conversationId" = mp."conversationId"
        AND m."senderId" <> mp."userId"
        AND (mp."lastReadAt" IS NULL OR m."createdAt" > mp."lastReadAt")
      GROUP BY mp."userId", mp."status"
    `);

    const out = new Map<string, number>();
    for (const r of rows) {
      const uid = String(r?.userId ?? '').trim();
      if (!uid) continue;
      const n = Math.max(0, Math.floor(r?.count ?? 0));
      out.set(uid, (out.get(uid) ?? 0) + n);
    }
    return out;
  }
}
