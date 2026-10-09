import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { toPage } from '../../common/pagination/page';
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { BillingService } from "../billing/billing.service";
import { PostsReadService } from "../posts-read/posts-read.service";
import type { AdminMemberDiagnosticsDto, AdminOperationsContentDto } from "../../common/dto/admin-operations.dto";
import { USER_BRIEF_SELECT } from '../../common/prisma-selects/user.select';
import { createdAtIdBefore } from '../../common/pagination/created-at-id-cursor';
import { NOT_DELETED } from '../../common/prisma/where';

export const adminOperationsIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const adminOperationsContentSchema = z
  .object({
    since: z.string().datetime().optional(),
    before: z.string().datetime().optional(),
    q: z.string().trim().min(1).max(200).optional(),
    unanswered: z.enum(["true", "false"]).optional(),
    /** `posts` (default, regular posts), `board` (Board posts), or `all`. */
    source: z.enum(["posts", "board", "all"]).default("posts"),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: adminOperationsIdSchema.optional(),
  })
  .strict();

@Injectable()
export class AdminOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly postsRead: PostsReadService,
  ) {}

  async memberDiagnostics(id: string): Promise<AdminMemberDiagnosticsDto> {
    const now = new Date();
    const since = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
        29 * 86400000,
    );
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        ...USER_BRIEF_SELECT,
        createdAt: true,
        verifiedStatus: true,
        bannedAt: true,
        lastSeenAt: true,
        usernameIsSet: true,
        birthdate: true,
        menOnlyConfirmed: true,
        emailVerifiedAt: true,
        stripeSubscriptionStatus: true,
        stripeCurrentPeriodEnd: true,
        stripeCancelAtPeriodEnd: true,
        stripeSubscriptionId: true,
        appleStatus: true,
        appleExpiresAt: true,
        appleAutoRenew: true,
        appleEnvironment: true,
        appleOriginalTransactionId: true,
      },
    });
    if (!user) throw new NotFoundException("User not found.");
    const [billing, activeDays, activeSessions, openFeedback] =
      await Promise.all([
        this.billing.getMe(id),
        this.prisma.userDailyActivity.count({
          where: { userId: id, day: { gte: since, lte: now } },
        }),
        this.prisma.session.count({
          where: {
            userId: id,
            revokedAt: null,
            expiresAt: { gt: now },
            impersonatedByUserId: null,
          },
        }),
        this.prisma.feedback.count({
          where: { userId: id, status: { in: ["new", "triaged"] } },
        }),
      ]);
    return {
      asOf: now.toISOString(),
      member: {
        id,
        username: user.username,
        name: user.name,
        createdAt: user.createdAt.toISOString(),
        verifiedStatus: user.verifiedStatus,
        bannedAt: user.bannedAt?.toISOString() ?? null,
        lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
        usernameIsSet: user.usernameIsSet,
        hasBirthdate: user.birthdate !== null,
        menOnlyConfirmed: user.menOnlyConfirmed,
        emailVerified: user.emailVerifiedAt !== null,
      },
      billing,
      providers: {
        stripe: {
          status: user.stripeSubscriptionStatus,
          periodEnd: user.stripeCurrentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: user.stripeCancelAtPeriodEnd,
          hasSubscription: !!user.stripeSubscriptionId,
        },
        apple: {
          status: user.appleStatus,
          expiresAt: user.appleExpiresAt?.toISOString() ?? null,
          autoRenew: user.appleAutoRenew,
          environment: user.appleEnvironment,
          hasPurchase: !!user.appleOriginalTransactionId,
        },
      },
      activity: {
        since: since.toISOString(),
        activeDays,
        activeSessions,
        openFeedback,
      },
      limitations: [
        "Provider state is the last value recorded by the API, not a live Stripe or Apple receipt check.",
        "Subscription or entitlement status is not proof of payment or recognized revenue.",
        "Activity covers 30 UTC calendar dates including today; today is partial.",
      ],
    };
  }

  /** Accepts the raw query so callers outside HTTP get the same validation. */
  async content(query: unknown): Promise<{
    data: AdminOperationsContentDto;
    pagination: { nextCursor: string | null };
  }> {
    const input = adminOperationsContentSchema.parse(query);
    const now = new Date();
    const before = input.before ? new Date(input.before) : now;
    const since = input.since
      ? new Date(input.since)
      : new Date(before.getTime() - 7 * 86400000);
    if (
      before > now ||
      before <= since ||
      before.getTime() - since.getTime() > 31 * 86400000
    ) {
      throw new BadRequestException(
        "Choose a past interval of at most 31 days.",
      );
    }
    const where: Prisma.PostWhereInput = {
      createdAt: { gte: since, lt: before },
      visibility: "public",
      communityGroupId: null,
      parentId: null,
      kind: input.source === "all" ? { in: ["regular", "board"] } : input.source === "board" ? "board" : "regular",
      isDraft: false,
      ...NOT_DELETED,
      user: { isBot: false, ...NOT_BANNED_USER_WHERE },
      ...(input.q
        ? {
            OR: [
              { body: { contains: input.q, mode: "insensitive" as const } },
              { boardThread: { is: { title: { contains: input.q, mode: "insensitive" as const } } } },
            ],
          }
        : {}),
      ...(input.unanswered === "true"
        ? {
            replies: {
              none: {
                isDraft: false,
                ...NOT_DELETED,
                visibility: "public",
                user: NOT_BANNED_USER_WHERE,
              },
            },
          }
        : {}),
    };
    if (input.cursor) {
      // Check the cursor against this same audience and interval; never reset to page one.
      const cursor = await this.postsRead.findFirst({
        where: { AND: [where, { id: input.cursor }] },
        select: { id: true, createdAt: true },
      });
      if (!cursor)
        throw new BadRequestException(
          "Cursor is no longer available. Restart the content query.",
        );
      where.AND = [
        createdAtIdBefore({ createdAt: cursor.createdAt, id: cursor.id }),
      ];
    }
    const rows = await this.postsRead.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      select: {
        id: true,
        createdAt: true,
        body: true,
        commentCount: true,
        boostCount: true,
        kind: true,
        boardThread: { select: { title: true, url: true, tags: true } },
        user: { select: USER_BRIEF_SELECT },
      },
    });
    const { items: page, nextCursor } = toPage(rows, input.limit, (last) => last.id);
    return {
      data: {
        asOf: now.toISOString(),
        since: since.toISOString(),
        before: before.toISOString(),
        posts: page.map(({ user, createdAt, kind, boardThread, ...post }) => ({
          ...post,
          createdAt: createdAt.toISOString(),
          author: user,
          kind: kind === "board" ? ("board" as const) : ("post" as const),
          ...(boardThread ? { board: boardThread } : {}),
        })),
      },
      pagination: {
        nextCursor,
      },
    };
  }
}
