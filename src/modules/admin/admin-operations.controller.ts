import { AdminEngagementService } from './admin-engagement.service';
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { BillingService } from "../billing/billing.service";
import { AdminGuard } from "./admin.guard";
import type {
  AdminMemberDiagnosticsDto,
  AdminOperationsContentDto,
  AdminOperationsHealthDto,
} from "../../common/dto/admin-operations.dto";

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const contentSchema = z
  .object({
    since: z.string().datetime().optional(),
    before: z.string().datetime().optional(),
    q: z.string().trim().min(1).max(200).optional(),
    unanswered: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: idSchema.optional(),
  })
  .strict();

@Controller("admin/operations")
@UseGuards(AdminGuard)
export class AdminOperationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly engagement: AdminEngagementService,
  ) {}

  @Get('attention')
  async attention() { return { data: await this.engagement.attention() }; }

  @Get('activation')
  async activation(@Query() query: unknown) {
    const input = z.object({
      days: z.coerce.number().pipe(z.union([z.literal(30), z.literal(90)])).default(30),
      stage: z.enum(['joined', 'verified', 'contributed', 'returned']).optional(),
      offset: z.coerce.number().int().min(0).max(10000).default(0),
      limit: z.coerce.number().int().min(1).max(50).default(25),
    }).strict().parse(query);
    return { data: await this.engagement.activation(input) };
  }

  @Get("members/:id")
  async member(
    @Param("id") rawId: string,
  ): Promise<{ data: AdminMemberDiagnosticsDto }> {
    const id = idSchema.parse(rawId);
    const now = new Date();
    const since = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
        29 * 86400000,
    );
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        name: true,
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
      data: {
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
      },
    };
  }

  @Get("health")
  async health(): Promise<{ data: AdminOperationsHealthDto }> {
    return { data: await this.engagement.health() };
  }

  @Get("content")
  async content(
    @Query() query: unknown,
  ): Promise<{
    data: AdminOperationsContentDto;
    pagination: { nextCursor: string | null };
  }> {
    const input = contentSchema.parse(query);
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
      kind: "regular",
      isDraft: false,
      deletedAt: null,
      user: { isBot: false, bannedAt: null },
      ...(input.q
        ? { body: { contains: input.q, mode: "insensitive" as const } }
        : {}),
      ...(input.unanswered === "true"
        ? {
            replies: {
              none: {
                isDraft: false,
                deletedAt: null,
                visibility: "public",
                user: { bannedAt: null },
              },
            },
          }
        : {}),
    };
    if (input.cursor) {
      // Check the cursor against this same audience and interval; never reset to page one.
      const cursor = await this.prisma.post.findFirst({
        where: { AND: [where, { id: input.cursor }] },
        select: { id: true, createdAt: true },
      });
      if (!cursor)
        throw new BadRequestException(
          "Cursor is no longer available. Restart the content query.",
        );
      where.OR = [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ];
    }
    const rows = await this.prisma.post.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      select: {
        id: true,
        createdAt: true,
        body: true,
        commentCount: true,
        boostCount: true,
        user: { select: { id: true, username: true, name: true } },
      },
    });
    const page = rows.slice(0, input.limit);
    return {
      data: {
        asOf: now.toISOString(),
        since: since.toISOString(),
        before: before.toISOString(),
        posts: page.map(({ user, createdAt, ...post }) => ({
          ...post,
          createdAt: createdAt.toISOString(),
          author: user,
        })),
      },
      pagination: {
        nextCursor: rows.length > input.limit ? page.at(-1)!.id : null,
      },
    };
  }
}
