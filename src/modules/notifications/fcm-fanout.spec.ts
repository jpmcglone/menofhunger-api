import { NotificationPushDeliveryService } from "./notification-push-delivery.service";

function fixture() {
  const prisma = {
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ accountKind: "person", username: "member" }),
    },
    pushCoalesce: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
  const config = {
    vapidConfigured: () => false,
    pushFrontendBaseUrl: () => "https://menofhunger.com",
    allowedOrigins: () => [],
  };
  const apns = { configured: () => false };
  const fcm = {
    configured: () => true,
    sendToUser: jest.fn().mockResolvedValue(undefined),
    hasTokens: jest.fn().mockResolvedValue(true),
  };
  const service = new NotificationPushDeliveryService(
    prisma as never,
    config as never,
    apns as never,
    {} as never,
    fcm as never,
  );
  return { service, prisma, fcm };
}

describe("FCM shared notification fanout", () => {
  it("enables delivery without APNs/VAPID and preserves the protected destination callback", async () => {
    const { service, fcm } = fixture();
    const canDeliver = jest.fn().mockResolvedValue(true);
    expect(service.pushChannelConfigured()).toBe(true);
    await expect(service.hasFcmTokens("user-1")).resolves.toBe(true);
    await service.sendWebPushToRecipient("user-1", {
      title: "Private group and authored content never enter the FCM adapter",
      body: "private text",
      url: "https://menofhunger.com/g/group/channels/channel?thread=message",
      notificationId: "notification-1",
      tag: "channel-channel",
      kind: "channel_message",
      canDeliver,
    });
    expect(fcm.sendToUser).toHaveBeenCalledWith("user-1", {
      recipientUserId: "user-1",
      eventId: "notification-1",
      kind: "channel_message",
      destination: "/g/group/channels/channel?thread=message",
      tag: "channel-channel",
      canDeliver,
    });
  });

  it("does not bypass a denied or unavailable destination policy", async () => {
    const { service, fcm } = fixture();
    await service.sendWebPushToRecipient("user-1", {
      title: "new activity",
      canDeliver: async () => false,
    });
    await expect(
      service.sendWebPushToRecipient("user-1", {
        title: "new activity",
        canDeliver: async () => {
          throw new Error("policy unavailable");
        },
      }),
    ).rejects.toThrow("policy unavailable");
    expect(fcm.sendToUser).not.toHaveBeenCalled();
  });

  it("resolves unknown/external destinations to the authenticated notification inbox", async () => {
    const { service, fcm } = fixture();
    await service.sendWebPushToRecipient("user-1", {
      title: "new activity",
      url: "https://evil.example/chat",
    });
    expect(fcm.sendToUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ destination: "/notifications" }),
    );
  });

  it("shares the existing coalescing window rather than delivering Android duplicates", async () => {
    const { service, prisma, fcm } = fixture();
    prisma.pushCoalesce.findUnique.mockResolvedValue({ sentAt: new Date() });
    await service.sendWebPushToRecipient("user-1", {
      title: "new activity",
      tag: "message-conversation",
      kind: "message",
    });
    expect(fcm.sendToUser).not.toHaveBeenCalled();
  });
});
