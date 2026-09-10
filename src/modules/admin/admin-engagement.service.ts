import type { AdminOperationsHealthDto } from '../../common/dto/admin-operations.dto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AdminActivationDto,
  AdminAttentionDto,
  AdminAttentionItemDto,
  AdminAttentionPulseDto,
} from '../../common/dto/admin-engagement.dto';

const MS_DAY = 86400000;
const PULSE_WINDOW_DAYS = 7;
const PREVIEW_LIMIT = 8;
const memberAuthor: Prisma.UserWhereInput = {
  isBot: false, bannedAt: null, accountKind: 'person', siteAdmin: false,
};
const humanAuthor: Prisma.UserWhereInput = { isBot: false, bannedAt: null };
const publicRoot: Prisma.PostWhereInput = {
  visibility: 'public', communityGroupId: null, parentId: null, kind: 'regular',
  isDraft: false, deletedAt: null,
};
const humanReply: Prisma.PostWhereInput = { isDraft: false, deletedAt: null, user: humanAuthor };

export function utcDayMs(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function rate(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 1000) / 10;
}

export function summarizeAttentionPulse(input: {
  now: Date;
  since: Date;
  roots: Array<{ userId: string; createdAt: Date; firstHumanReplyAt: Date | null }>;
  activityDays: Array<{ userId: string; day: Date }>;
  lodge: { id: string; humanReplies: number } | null;
  verificationPending: number;
  oldestVerificationRequestedAt: Date | null;
}): AdminAttentionPulseDto {
  const authorIds = [...new Set(input.roots.map((root) => root.userId))];
  const repliedWithin24h = input.roots.filter((root) => {
    if (!root.firstHumanReplyAt) return false;
    return root.firstHumanReplyAt.getTime() - root.createdAt.getTime() <= MS_DAY;
  }).length;
  const authorsReturned = authorIds.filter((userId) => {
    const rootDays = input.roots.filter((root) => root.userId === userId).map((root) => utcDayMs(root.createdAt));
    return input.activityDays.some((row) => row.userId === userId && rootDays.some((day) => utcDayMs(row.day) > day));
  }).length;
  return {
    windowDays: PULSE_WINDOW_DAYS,
    since: input.since.toISOString(),
    before: input.now.toISOString(),
    memberRoots: input.roots.length,
    repliedWithin24h,
    replyRate24hPct: rate(repliedWithin24h, input.roots.length),
    authors: authorIds.length,
    authorsReturned,
    authorsReturnedPct: rate(authorsReturned, authorIds.length),
    lodgePromptReplies: input.lodge?.humanReplies ?? null,
    lodgePromptId: input.lodge?.id ?? null,
    verificationPending: input.verificationPending,
    oldestVerificationRequestedAt: input.oldestVerificationRequestedAt?.toISOString() ?? null,
    definitions: [
      'Member posts: public regular roots from personal, non-admin, non-bot, non-banned accounts in this 7-day window. Pages and site admins are excluded.',
      'Answered in 24 hours: a published human reply arrived within 24 hours of the post. Bot replies do not count.',
      'Authors active again: those member-post authors had recorded activity on a later UTC day after at least one of those posts.',
      'Lodge prompt: human replies to the latest public @menofhunger root in the window. Null when there is no such prompt.',
      'Oldest verification wait: the earliest pending request from an active unverified account. Inbox unanswered counts still include official posts over 14 days.',
    ],
  };
}

@Injectable()
export class AdminEngagementService {
  constructor(private readonly prisma: PrismaService) {}

  async health(): Promise<AdminOperationsHealthDto> {
    const now = new Date();
    const [
      newFeedback,
      triaged,
      pendingReports,
      unprocessed,
      olderThan15Minutes,
      oldest,
      scheduledPostsWithFailures,
    ] = await Promise.all([
      this.prisma.feedback.count({ where: { status: "new" } }),
      this.prisma.feedback.count({ where: { status: "triaged" } }),
      this.prisma.report.count({ where: { status: "pending" } }),
      this.prisma.stripeWebhookEvent.count({ where: { processedAt: null } }),
      this.prisma.stripeWebhookEvent.count({
        where: {
          processedAt: null,
          createdAt: { lt: new Date(now.getTime() - 15 * 60000) },
        },
      }),
      this.prisma.stripeWebhookEvent.findFirst({
        where: { processedAt: null },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      this.prisma.post.count({
        where: {
          isDraft: true,
          deletedAt: null,
          scheduledAt: { not: null },
          scheduledFailedAt: { not: null },
        },
      }),
    ]);
    return {
        asOf: now.toISOString(),
        feedback: { new: newFeedback, triaged },
        pendingReports,
        stripeWebhooks: {
          unprocessed,
          olderThan15Minutes,
          oldestReceivedAt: oldest?.createdAt.toISOString() ?? null,
        },
        scheduledPostsWithFailures,
        limitations: [
          "Unprocessed webhooks can be in flight; age is a signal for investigation, not a failure diagnosis.",
          "This snapshot does not include HTTP error rates, mobile crashes, deployment history, or payment receipts.",
        ],
    };
  }


  async attention(): Promise<AdminAttentionDto> {
    const now = new Date();
    const since = new Date(now.getTime() - PULSE_WINDOW_DAYS * MS_DAY);
    const unansweredWhere: Prisma.PostWhereInput = {
      ...publicRoot,
      createdAt: { gte: new Date(now.getTime() - 14 * MS_DAY) },
      user: humanAuthor,
      replies: { none: humanReply },
    };
    const previewSelect = { id: true, body: true, createdAt: true, user: { select: { username: true } } };
    const pendingVerification = { status: 'pending' as const, user: { bannedAt: null, verifiedStatus: 'none' as const } };
    const [health, verification, unanswered, memberPreview, oldestVerification, roots, lodge] = await Promise.all([
      this.health(),
      this.prisma.verificationRequest.count({ where: pendingVerification }),
      this.prisma.post.count({ where: unansweredWhere }),
      this.prisma.post.findMany({
        where: { ...unansweredWhere, user: memberAuthor },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: PREVIEW_LIMIT,
        select: previewSelect,
      }),
      this.prisma.verificationRequest.findFirst({
        where: pendingVerification,
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prisma.post.findMany({
        where: { ...publicRoot, createdAt: { gte: since, lte: now }, user: memberAuthor },
        select: {
          userId: true,
          createdAt: true,
          replies: { where: humanReply, orderBy: { createdAt: 'asc' }, take: 1, select: { createdAt: true } },
        },
      }),
      this.prisma.post.findFirst({
        where: { ...publicRoot, createdAt: { gte: since, lte: now }, user: { username: 'menofhunger' } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, replies: { where: humanReply, select: { id: true } } },
      }),
    ]);
    const otherPreview = memberPreview.length >= PREVIEW_LIMIT ? [] : await this.prisma.post.findMany({
      where: {
        ...unansweredWhere,
        user: { ...humanAuthor, OR: [{ siteAdmin: true }, { accountKind: { not: 'person' } }] },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: PREVIEW_LIMIT - memberPreview.length,
      select: previewSelect,
    });
    const authorIds = [...new Set(roots.map((root) => root.userId))];
    const earliestRootDay = authorIds.length === 0 ? null : new Date(Math.min(...roots.map((root) => utcDayMs(root.createdAt))));
    const activityDays = earliestRootDay == null ? [] : await this.prisma.userDailyActivity.findMany({
      where: { userId: { in: authorIds }, day: { gt: earliestRootDay } },
      select: { userId: true, day: true },
    });
    const items: AdminAttentionItemDto[] = [
      { id: 'reports', title: 'Reports to review', detail: 'Pending reports', count: health.pendingReports, path: '/admin/reports', priority: 'review' },
      { id: 'webhooks', title: 'Payment events to investigate', detail: 'Unprocessed for over 15 minutes; this does not prove a payment failed', count: health.stripeWebhooks.olderThan15Minutes, path: '/admin/jobs', priority: 'investigate' },
      { id: 'scheduled', title: 'Scheduled posts with failures', detail: 'Saved drafts with a recorded scheduling failure', count: health.scheduledPostsWithFailures, path: '/admin/jobs', priority: 'investigate' },
      { id: 'verification', title: 'Members waiting for verification', detail: 'Pending requests from people who are not banned.', count: verification, path: '/admin/verification', priority: 'review' },
      { id: 'feedback', title: 'Feedback to follow up', detail: 'New and triaged feedback', count: health.feedback.new + health.feedback.triaged, path: '/admin/feedback', priority: 'review' },
      { id: 'unanswered', title: 'Conversations needing a reply', detail: 'Public posts from the past 14 days with no human replies. Member posts are listed first.', count: unanswered, path: '/admin/attention/conversations', priority: 'participate' },
    ];
    return {
      asOf: now.toISOString(),
      items,
      unansweredPosts: [...memberPreview, ...otherPreview].map((post) => ({
        id: post.id, body: post.body.slice(0, 300), username: post.user.username, createdAt: post.createdAt.toISOString(),
      })),
      pulse: summarizeAttentionPulse({
        now,
        since,
        roots: roots.map((root) => ({
          userId: root.userId,
          createdAt: root.createdAt,
          firstHumanReplyAt: root.replies[0]?.createdAt ?? null,
        })),
        activityDays,
        lodge: lodge ? { id: lodge.id, humanReplies: lodge.replies.length } : null,
        verificationPending: verification,
        oldestVerificationRequestedAt: oldestVerification?.createdAt ?? null,
      }),
    };
  }

  async activation(input: { days: number; stage?: string; offset: number; limit: number }): Promise<AdminActivationDto> {
    const now = new Date();
    const since = new Date(now.getTime() - input.days * 86400000);
    // A single database snapshot drives both the complete cohort totals and filtered pagination.
    const [result] = await this.prisma.$queryRaw<Array<Pick<AdminActivationDto, 'counts' | 'members' | 'matching'>>>(Prisma.sql`
      WITH cohort AS (
        SELECT u."id", u."username", u."createdAt", u."verifiedAt",
          p.at AS "contributedAt", a.at AS "returnedAt",
          CASE WHEN a.at IS NOT NULL THEN 'returned' WHEN p.at IS NOT NULL THEN 'contributed'
            WHEN u."verifiedAt" IS NOT NULL THEN 'verified' ELSE 'joined' END AS stage
        FROM "User" u
        LEFT JOIN LATERAL (
          SELECT MIN("createdAt") AS at FROM "Post"
          WHERE "userId" = u.id AND "createdAt" >= u."verifiedAt" AND "createdAt" <= ${now}
            AND "deletedAt" IS NULL AND NOT "isDraft" AND "visibility" = 'public'
            AND "communityGroupId" IS NULL AND "kind" = 'regular'
        ) p ON true
        LEFT JOIN LATERAL (
          SELECT MIN(day) AS at FROM "UserDailyActivity"
          WHERE "userId" = u.id AND day > date_trunc('day', p.at) AND day <= ${now}
        ) a ON true
        WHERE NOT u."isBot" AND u."bannedAt" IS NULL AND u."accountKind" = 'person'
          AND u."createdAt" >= ${since} AND u."createdAt" <= ${now}
      ), filtered AS (SELECT * FROM cohort WHERE ${input.stage ?? null}::text IS NULL OR stage = ${input.stage ?? null}),
      page AS (SELECT * FROM filtered ORDER BY "createdAt" DESC, id DESC LIMIT ${input.limit} OFFSET ${input.offset})
      SELECT json_build_object('joined', COUNT(*)::int, 'verified', COUNT("verifiedAt")::int,
        'contributed', COUNT("contributedAt")::int, 'returned', COUNT("returnedAt")::int) AS counts,
        COALESCE((SELECT json_agg(json_build_object(
          'id', id, 'username', username, 'stage', stage,
          'createdAt', to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'verifiedAt', to_char("verifiedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'contributedAt', to_char("contributedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'returnedAt', to_char("returnedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )) FROM page), '[]'::json) AS members,
        (SELECT COUNT(*)::int FROM filtered) AS matching FROM cohort
    `);
    return { ...result, asOf: now.toISOString(), since: since.toISOString(), ...input,
      definitions: [
        'Cohort: non-bot, non-banned personal accounts created in the selected rolling window; today is partial.',
        'Verified: a recorded verification date. Contribution: the first currently visible public post or reply after verification; group posts and drafts are excluded.',
        'Returned: recorded activity on a later UTC calendar day after that contribution. Recent members have had less time to return.',
        'These are observed milestones, not reasons for leaving. Deleted content and changes to verification dates can change historical counts.',
      ] };
  }
}
