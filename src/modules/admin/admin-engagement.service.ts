import type { AdminOperationsHealthDto } from '../../common/dto/admin-operations.dto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AdminActivationDto, AdminAttentionDto, AdminAttentionItemDto } from '../../common/dto/admin-engagement.dto';

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
    const unansweredWhere: Prisma.PostWhereInput = {
      createdAt: { gte: new Date(now.getTime() - 14 * 86400000) },
      visibility: 'public', communityGroupId: null, parentId: null, kind: 'regular',
      isDraft: false, deletedAt: null, user: { isBot: false, bannedAt: null },
      replies: { none: { isDraft: false, deletedAt: null, user: { isBot: false, bannedAt: null } } },
    };
    const [health, verification, unanswered, posts] = await Promise.all([
      this.health(),
      this.prisma.verificationRequest.count({ where: { status: 'pending', user: { bannedAt: null } } }),
      this.prisma.post.count({ where: unansweredWhere }),
      this.prisma.post.findMany({ where: unansweredWhere, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 8,
        select: { id: true, body: true, createdAt: true, user: { select: { username: true } } } }),
    ]);
    const items: AdminAttentionItemDto[] = [
      { id: 'reports', title: 'Reports to review', detail: 'Pending reports', count: health.pendingReports, path: '/admin/reports', priority: 'review' },
      { id: 'webhooks', title: 'Payment events to investigate', detail: 'Unprocessed for over 15 minutes; this does not prove a payment failed', count: health.stripeWebhooks.olderThan15Minutes, path: '/admin/jobs', priority: 'investigate' },
      { id: 'scheduled', title: 'Scheduled posts with failures', detail: 'Saved drafts with a recorded scheduling failure', count: health.scheduledPostsWithFailures, path: '/admin/jobs', priority: 'investigate' },
      { id: 'verification', title: 'Members waiting for verification', detail: 'Pending requests from active accounts', count: verification, path: '/admin/verification', priority: 'review' },
      { id: 'feedback', title: 'Feedback to follow up', detail: 'New and triaged feedback', count: health.feedback.new + health.feedback.triaged, path: '/admin/feedback', priority: 'review' },
      { id: 'unanswered', title: 'Conversations needing a reply', detail: 'Public posts from the past 14 days with no human replies', count: unanswered, path: '/admin/attention#conversations', priority: 'participate' },
    ];
    return { asOf: now.toISOString(), items, unansweredPosts: posts.map(p => ({ id: p.id, body: p.body.slice(0, 300), username: p.user.username, createdAt: p.createdAt.toISOString() })) };
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
