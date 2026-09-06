import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import cookieParser from "cookie-parser";
import { AdminOperationsController } from "./admin-operations.controller";
import { AdminGuard } from "./admin.guard";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { BillingService } from "../billing/billing.service";
import { ApiExceptionFilter } from "../../common/filters/api-exception.filter";

describe("Admin operations HTTP boundary", () => {
  let app: INestApplication;
  const auth = { meFromSessionToken: jest.fn(), setSessionCookie: jest.fn() };
  const prisma = {
    user: { findUnique: jest.fn() },
    feedback: { count: jest.fn() },
    report: { count: jest.fn() },
    stripeWebhookEvent: { count: jest.fn(), findFirst: jest.fn() },
    post: { count: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
    userDailyActivity: { count: jest.fn() },
    session: { count: jest.fn() },
  };
  const billing = { getMe: jest.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AdminOperationsController],
      providers: [
        AdminGuard,
        { provide: AuthService, useValue: auth },
        { provide: PrismaService, useValue: prisma },
        { provide: BillingService, useValue: billing },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new ApiExceptionFilter());
    app.setGlobalPrefix("v1");
    await app.listen(0, "127.0.0.1");
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    jest.resetAllMocks();
    auth.meFromSessionToken.mockImplementation(async (token) =>
      token === "admin-session"
        ? {
            user: { id: "admin", siteAdmin: true },
            impersonatedByUserId: null,
            renewed: false,
          }
        : null,
    );
    for (const delegate of Object.values(prisma)) {
      if ("count" in delegate) delegate.count.mockResolvedValue(0);
    }
    prisma.stripeWebhookEvent.findFirst.mockResolvedValue(null);
    prisma.post.findMany.mockResolvedValue([]);
  });

  it.each(["health", "content", "members/member1"])(
    "hides %s from logged-out, non-admin and impersonated users",
    async (path) => {
      await request(app.getHttpServer())
        .get(`/v1/admin/operations/${path}`)
        .expect(404);
      auth.meFromSessionToken.mockResolvedValue({ user: { siteAdmin: false } });
      await request(app.getHttpServer())
        .get(`/v1/admin/operations/${path}`)
        .set("Cookie", "moh_session=user-session")
        .expect(404);
      auth.meFromSessionToken.mockResolvedValue({
        user: { siteAdmin: true },
        impersonatedByUserId: "another-admin",
      });
      await request(app.getHttpServer())
        .get(`/v1/admin/operations/${path}`)
        .set("Cookie", "moh_session=impersonation")
        .expect(404);
      expect(prisma.post.findMany).not.toHaveBeenCalled();
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.feedback.count).not.toHaveBeenCalled();
    },
  );

  it("preserves health counts and marks webhook age as a signal rather than a payment failure", async () => {
    prisma.feedback.count.mockResolvedValueOnce(4).mockResolvedValueOnce(2);
    prisma.stripeWebhookEvent.count
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1);
    prisma.stripeWebhookEvent.findFirst.mockResolvedValue({
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const { body } = await request(app.getHttpServer())
      .get("/v1/admin/operations/health")
      .set("Cookie", "moh_session=admin-session")
      .expect(200);
    expect(body.data.feedback).toEqual({ new: 4, triaged: 2 });
    expect(body.data.stripeWebhooks).toEqual({
      unprocessed: 3,
      olderThan15Minutes: 1,
      oldestReceivedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(body.data.limitations[0]).toContain("not a failure diagnosis");
  });

  it("rejects oversized, future, reversed and malformed content queries", async () => {
    for (const query of [
      { limit: 51 },
      { unanswered: "yes" },
      { unexpected: "value" },
      { before: "2999-01-01T00:00:00Z" },
      { since: "2025-01-01T00:00:00Z", before: "2025-03-01T00:00:00Z" },
      { since: "2025-03-01T00:00:00Z", before: "2025-02-01T00:00:00Z" },
    ]) {
      await request(app.getHttpServer())
        .get("/v1/admin/operations/content")
        .query(query)
        .set("Cookie", "moh_session=admin-session")
        .expect(400);
    }
    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });

  it("restricts content and unanswered replies to the intended public audience and paginates", async () => {
    const row = (id: string) => ({
      id,
      createdAt: new Date("2025-01-02T00:00:00Z"),
      body: "Hello",
      commentCount: 0,
      boostCount: 1,
      user: { id: "u1", username: "bob", name: "Bob" },
    });
    prisma.post.findMany.mockResolvedValue([row("p2"), row("p1")]);
    const { body } = await request(app.getHttpServer())
      .get("/v1/admin/operations/content")
      .query({
        unanswered: true,
        limit: 1,
        since: "2025-01-01T00:00:00Z",
        before: "2025-01-03T00:00:00Z",
      })
      .set("Cookie", "moh_session=admin-session")
      .expect(200);
    expect(body.data.posts).toHaveLength(1);
    expect(body.pagination.nextCursor).toBe("p2");
    expect(body.data.posts[0].author.username).toBe("bob");
    const query = prisma.post.findMany.mock.calls[0][0];
    expect(query.where).toMatchObject({
      visibility: "public",
      communityGroupId: null,
      parentId: null,
      kind: "regular",
      isDraft: false,
      deletedAt: null,
      user: { isBot: false, bannedAt: null },
      replies: {
        none: {
          isDraft: false,
          deletedAt: null,
          visibility: "public",
          user: { bannedAt: null },
        },
      },
    });
    expect(query.take).toBe(2);
  });

  it("rejects missing/stale or out-of-scope cursors instead of repeating page one", async () => {
    prisma.post.findFirst.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get("/v1/admin/operations/content")
      .query({ cursor: "gone" })
      .set("Cookie", "moh_session=admin-session")
      .expect(400);
    expect(prisma.post.findMany).not.toHaveBeenCalled();
    expect(prisma.post.findFirst.mock.calls[0][0].where.AND[0].visibility).toBe(
      "public",
    );
  });

  it("reuses canonical billing data and exposes presence flags instead of sensitive identifiers", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: "member1",
      username: "bob",
      name: "Bob",
      createdAt: new Date("2025-01-01"),
      verifiedStatus: "none",
      bannedAt: null,
      lastSeenAt: null,
      usernameIsSet: true,
      birthdate: new Date("1980-01-01"),
      menOnlyConfirmed: true,
      emailVerifiedAt: null,
      stripeSubscriptionStatus: "active",
      stripeSubscriptionId: "sub_SECRET",
      stripeCurrentPeriodEnd: new Date("2026-10-01"),
      stripeCancelAtPeriodEnd: false,
      appleStatus: null,
      appleExpiresAt: null,
      appleAutoRenew: false,
      appleEnvironment: null,
      appleOriginalTransactionId: "APPLE_SECRET",
    });
    const canonical = {
      premium: false,
      premiumPlus: false,
      verified: false,
      source: null,
      grants: [],
    };
    billing.getMe.mockResolvedValue(canonical);
    const { body } = await request(app.getHttpServer())
      .get("/v1/admin/operations/members/member1")
      .set("Cookie", "moh_session=admin-session")
      .expect(200);
    expect(billing.getMe).toHaveBeenCalledWith("member1");
    expect(body.data.billing).toEqual(canonical);
    expect(body.data.member.hasBirthdate).toBe(true);
    expect(body.data.providers.stripe.hasSubscription).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(
      /sub_SECRET|APPLE_SECRET|1980-01-01/,
    );
    expect(prisma.session.count.mock.calls[0][0].where).toMatchObject({
      revokedAt: null,
      impersonatedByUserId: null,
    });
  });

  it("returns 404 for a missing member without calling billing", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get("/v1/admin/operations/members/missing")
      .set("Cookie", "moh_session=admin-session")
      .expect(404);
    expect(billing.getMe).not.toHaveBeenCalled();
  });
});
