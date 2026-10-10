import { ForbiddenException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { FcmPushService } from "./fcm-push.service";
import {
  fcmRegisterSchema,
  fcmUnregisterSchema,
} from "./fcm-devices.controller";

const installationId = "bbd3055b-69d1-4684-bfde-2e5151ab810f";
const bindingId = "2612a34c-3521-44f0-8d94-af2620096051";
const user = {
  id: "user-1",
  sessionId: "session-1",
  accountKind: "person" as const,
};
const input = { installationId, token: "token-1", notificationsEnabled: true };
const sendInput = {
  recipientUserId: user.id,
  eventId: "event-1",
  kind: "message",
  destination: "/chat?c=conversation-1",
  tag: "message-conversation-1",
};

function fixture() {
  const registration = {
    id: "registration-1",
    ...input,
    bindingId,
    userId: user.id,
    sessionId: user.sessionId,
  };
  const prisma = {
    session: { findFirst: jest.fn().mockResolvedValue({ id: user.sessionId }) },
    fcmDeviceRegistration: {
      findUnique: jest.fn().mockResolvedValue(registration),
      findMany: jest.fn().mockResolvedValue([registration]),
      findFirst: jest.fn().mockResolvedValue({ id: registration.id }),
      upsert: jest.fn().mockResolvedValue(registration),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(1),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (action: (tx: unknown) => unknown) => action(prisma),
  );
  const messaging = {
    configured: jest.fn().mockReturnValue(true),
    send: jest.fn().mockResolvedValue("fcm-message-1"),
  };
  const service = new FcmPushService(prisma as never, messaging as never);
  return { service, prisma, messaging, registration };
}

describe("FCM session/install lifecycle", () => {
  it("uses normal priority for ordinary activity and expires a late check-in reminder at closing", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-11T03:59:00.000Z"));
    try {
      const { service, messaging } = fixture();
      await service.sendToUser(user.id, {
        ...sendInput,
        kind: "checkin_reminder",
      });
      expect(messaging.send).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            expiresAt: "2026-10-11T04:00:00.000Z",
          }),
          android: { priority: "normal", ttl: 60_000 },
        }),
      );
      messaging.send.mockClear();
      jest.setSystemTime(new Date("2026-10-11T04:00:00.000Z"));
      await service.sendToUser(user.id, {
        ...sendInput,
        kind: "checkin_reminder",
      });
      expect(messaging.send).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
  it("uses only the authenticated live personal session and keeps identical registrations idempotent", async () => {
    const { service, prisma } = fixture();
    await expect(service.register(user, input)).resolves.toEqual({ bindingId });
    expect(prisma.session.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: user.sessionId,
          userId: user.id,
          revokedAt: null,
          expiresAt: { gt: expect.any(Date) },
          impersonatedByUserId: null,
          operatedByUserId: null,
          user: {
            accountKind: "person",
            bannedAt: null,
            deletionScheduledAt: null,
          },
        },
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(prisma.fcmDeviceRegistration.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          userId: user.id,
          sessionId: user.sessionId,
          bindingId,
        }),
      }),
    );
  });

  it.each(["sessionId", "userId", "token"] as const)(
    "rotates the binding when %s changes",
    async (field) => {
      const { service, prisma, registration } = fixture();
      prisma.fcmDeviceRegistration.findUnique.mockResolvedValue({
        ...registration,
        [field]: "obsolete",
      });
      const result = await service.register(user, input);
      expect(result.bindingId).not.toBe(bindingId);
      expect(result.bindingId).toMatch(/^[a-f\d-]{36}$/);
      expect(prisma.fcmDeviceRegistration.deleteMany).toHaveBeenCalledWith({
        where: { token: input.token, NOT: { installationId } },
      });
    },
  );

  it("updates permission without silently changing the binding", async () => {
    const { service, prisma } = fixture();
    await expect(
      service.register(user, { ...input, notificationsEnabled: false }),
    ).resolves.toEqual({ bindingId });
    expect(prisma.fcmDeviceRegistration.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ notificationsEnabled: false }),
      }),
    );
  });

  it("rejects expired/revoked/banned/deleting sessions even if the auth guard has a cached session", async () => {
    const { service, prisma } = fixture();
    prisma.session.findFirst.mockResolvedValue(null);
    await expect(service.register(user, input)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.fcmDeviceRegistration.upsert).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { ...user, sessionId: undefined },
    { ...user, impersonatedByUserId: "admin" },
    { ...user, operatedByUserId: "operator" },
    { ...user, accountKind: "page" as const },
  ])(
    "rejects missing or non-person identities before touching the registry",
    async (identity) => {
      const { service, prisma } = fixture();
      await expect(service.register(identity, input)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it("scopes stale unregister requests to the exact installation, binding, user and session", async () => {
    const { service, prisma } = fixture();
    await service.unregister(user, { installationId, bindingId });
    expect(prisma.fcmDeviceRegistration.deleteMany).toHaveBeenCalledWith({
      where: {
        installationId,
        bindingId,
        userId: user.id,
        sessionId: user.sessionId,
      },
    });
  });

  it("retries a concurrent registration conflict using a fresh transaction", async () => {
    const { service, prisma } = fixture();
    prisma.$transaction.mockRejectedValueOnce({ code: "P2034" });
    await expect(service.register(user, input)).resolves.toEqual({ bindingId });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("rejects spoofed identity fields and oversized/empty tokens at the request boundary", () => {
    expect(
      fcmRegisterSchema.safeParse({ ...input, userId: "victim" }).success,
    ).toBe(false);
    expect(
      fcmRegisterSchema.safeParse({ ...input, sessionId: "stolen" }).success,
    ).toBe(false);
    expect(
      fcmRegisterSchema.safeParse({ ...input, token: " ".repeat(10) }).success,
    ).toBe(false);
    expect(
      fcmRegisterSchema.safeParse({ ...input, token: "a".repeat(4097) })
        .success,
    ).toBe(false);
    expect(
      fcmUnregisterSchema.safeParse({ installationId, bindingId: "not-uuid" })
        .success,
    ).toBe(false);
  });
});

describe("FCM data-only delivery authorization", () => {
  it("sends only generic copy with the exact binding, recipient, expiry and authenticated destination", async () => {
    const { service, prisma, messaging } = fixture();
    const canDeliver = jest.fn().mockResolvedValue(true);
    await service.sendToUser(user.id, { ...sendInput, canDeliver });
    expect(canDeliver).toHaveBeenCalledTimes(1);
    expect(prisma.fcmDeviceRegistration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          bindingId,
          token: input.token,
          userId: user.id,
          notificationsEnabled: true,
          session: expect.objectContaining({
            revokedAt: null,
            expiresAt: { gt: expect.any(Date) },
            user: {
              accountKind: "person",
              bannedAt: null,
              deletionScheduledAt: null,
            },
          }),
        }),
      }),
    );
    const message = messaging.send.mock.calls[0][0];
    expect(message).toEqual({
      token: input.token,
      android: { priority: "high", ttl: expect.any(Number) },
      data: {
        schemaVersion: "1",
        bindingId,
        recipientUserId: user.id,
        eventId: "event-1",
        kind: "message",
        destination: sendInput.destination,
        expiresAt: expect.any(String),
        tag: sendInput.tag,
        title: "New message",
        body: "Open Men of Hunger to read your message.",
      },
    });
    expect(
      Object.values(message.data).every((value) => typeof value === "string"),
    ).toBe(true);
    expect(new Date(message.data.expiresAt).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(message).not.toHaveProperty("notification");
    expect(message.android.ttl).toBeGreaterThan(0);
    expect(message.android.ttl).toBeLessThanOrEqual(3600000);
  });

  it("suppresses a revoked, rotated, disabled or deleting binding after fanout was loaded", async () => {
    const { service, prisma, messaging } = fixture();
    prisma.fcmDeviceRegistration.findFirst.mockResolvedValue(null);
    await service.sendToUser(user.id, sendInput);
    expect(messaging.send).not.toHaveBeenCalled();
  });

  it("checks destination eligibility independently before each installation send", async () => {
    const { service, prisma, messaging, registration } = fixture();
    prisma.fcmDeviceRegistration.findMany.mockResolvedValue([
      registration,
      { ...registration, id: "other" },
    ]);
    const canDeliver = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await service.sendToUser(user.id, { ...sendInput, canDeliver });
    expect(canDeliver).toHaveBeenCalledTimes(2);
    expect(messaging.send).toHaveBeenCalledTimes(1);
  });

  it("fails closed when session eligibility or destination eligibility cannot be read", async () => {
    const { service, prisma, messaging } = fixture();
    prisma.fcmDeviceRegistration.findFirst.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(service.sendToUser(user.id, sendInput)).rejects.toThrow(
      "FCM delivery unavailable",
    );
    await expect(
      service.sendToUser(user.id, {
        ...sendInput,
        canDeliver: async () => {
          throw new Error("policy unavailable");
        },
      }),
    ).rejects.toThrow("FCM delivery unavailable");
    expect(messaging.send).not.toHaveBeenCalled();
  });

  it("prunes permanent dead tokens with binding/token guards against late-response races", async () => {
    const { service, prisma, messaging, registration } = fixture();
    messaging.send.mockRejectedValue({
      code: "messaging/registration-token-not-registered",
    });
    await service.sendToUser(user.id, sendInput);
    expect(prisma.fcmDeviceRegistration.deleteMany).toHaveBeenCalledWith({
      where: { id: registration.id, token: input.token, bindingId },
    });
  });

  it("keeps tokens on transient failures and exposes protected delivery failures for retries", async () => {
    const { service, prisma, messaging } = fixture();
    messaging.send.mockRejectedValue({ code: "messaging/server-unavailable" });
    await expect(
      service.sendToUser(user.id, {
        ...sendInput,
        canDeliver: async () => true,
      }),
    ).rejects.toThrow("FCM delivery unavailable");
    expect(prisma.fcmDeviceRegistration.deleteMany).not.toHaveBeenCalled();
  });

  it.each(["/notifications", "/g/group/channels/channel?thread=message"])(
    "delivers safe relative destinations: %s",
    async (destination) => {
      const { service, messaging } = fixture();
      await service.sendToUser(user.id, { ...sendInput, destination });
      expect(messaging.send).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["https://evil.example/chat", "//evil.example/chat"])(
    "rejects external destinations: %s",
    async (destination) => {
      const { service, messaging } = fixture();
      await service.sendToUser(user.id, { ...sendInput, destination });
      expect(messaging.send).not.toHaveBeenCalled();
    },
  );

  it("does not send when credentials are unset or a page destination is fanned to a person", async () => {
    const { service, messaging } = fixture();
    messaging.configured.mockReturnValue(false);
    await service.sendToUser(user.id, sendInput);
    messaging.configured.mockReturnValue(true);
    await service.sendToUser(user.id, {
      ...sendInput,
      recipientUserId: "page-1",
    });
    expect(messaging.send).not.toHaveBeenCalled();
  });
});
