import { EmailDeliveryService, emailMediaUrls } from "./email-delivery.service";
import type { EmailDelivery } from "@prisma/client";

function setup() {
  const prisma = {
    emailDelivery: {
      upsert: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(),
      findUnique: jest.fn(async () => ({
        id: "delivery",
        recipientHash: "recipient-hash",
      })),
      findMany: jest.fn(async () => []),
    },
    emailProviderEvent: { findMany: jest.fn(async () => []) },
    emailSuppression: { upsert: jest.fn() },
  };
  const service = new EmailDeliveryService(
    prisma as never,
    { recipientHash: () => "hash" } as never,
  );
  const row = {
    id: "delivery",
    eventKey: "activation:user:1",
    attempts: 0,
    retryUntil: new Date(Date.now() + 3600000),
    status: "pending",
  } as EmailDelivery;
  return { prisma, service, row };
}

describe("durable email delivery", () => {
  it("claims the logical event atomically only within its provider idempotency window", async () => {
    const { prisma, service, row } = setup();
    await expect(service.claim(row)).resolves.toBe(true);
    expect(prisma.emailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "delivery",
          attempts: { lt: 6 },
          retryUntil: { gt: expect.any(Date) },
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: expect.any(Date) } }],
        }),
      }),
    );
    prisma.emailDelivery.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.claim({ ...row, retryUntil: new Date(0), status: "sending" }),
    ).resolves.toBe(false);
  });

  it("retains failed transient payloads for caller retry and erases them after final failure", async () => {
    const { prisma, service, row } = setup();
    await service.finish(
      row,
      { sent: false, reason: "email_failed", retryable: true },
      { to: "x@y.com", subject: "Hi", text: "Hi", retrySafe: false },
    );
    expect(prisma.emailDelivery.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "pending",
          lastError: "email_failed",
        }),
      }),
    );
    expect(
      prisma.emailDelivery.update.mock.calls[0][0].data,
    ).not.toHaveProperty("requestJson");
    await service.finish(
      { ...row, attempts: 5 },
      { sent: false, reason: "email_failed", retryable: true },
      { to: "x@y.com", subject: "Hi", text: "Hi" },
    );
    expect(prisma.emailDelivery.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed", requestJson: null }),
      }),
    );
  });

  it("quota delays do not consume the finite provider retry allowance", async () => {
    const { prisma, service, row } = setup();
    await service.finish(
      row,
      { sent: false, reason: "email_quota_hard_limit", retryable: true },
      {
        to: "x@y.com",
        subject: "Account notice",
        text: "Hi",
        category: "transactional",
      },
    );
    expect(prisma.emailDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "pending",
          attempts: { decrement: 1 },
        }),
      }),
    );
  });

  it("never automatically replays permission-dependent messages and expires uncertain leases", async () => {
    const { prisma, service } = setup();
    await service.due();
    expect(prisma.emailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["pending", "sending"] },
          retryUntil: { lte: expect.any(Date) },
        }),
        data: expect.objectContaining({ requestJson: null, status: "failed" }),
      }),
    );
    expect(prisma.emailDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          retrySafe: true,
          retryUntil: { gt: expect.any(Date) },
        }),
      }),
    );
  });

  it("keeps provider keys stable across attempts and records acceptance plus early delivery receipts", async () => {
    const { prisma, service, row } = setup();
    expect(service.providerKey(row)).toBe(
      service.providerKey({ ...row, attempts: 3 }),
    );
    prisma.emailProviderEvent.findMany.mockResolvedValue([
      { type: "email.delivered" },
    ] as never);
    await service.finish(
      row,
      { sent: true, providerMessageId: "provider-id" },
      { to: "x@y.com", subject: "Hi", text: "Hi" },
    );
    expect(prisma.emailDelivery.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          status: "sent",
          providerMessageId: "provider-id",
          requestJson: null,
        }),
      }),
    );
    expect(prisma.emailDelivery.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: "delivery", status: { notIn: ["bounced", "complained"] } },
        data: expect.objectContaining({
          status: "delivered",
          deliveredAt: expect.any(Date),
          requestJson: null,
        }),
      }),
    );
  });

  it("suppresses an early complaint receipt even if its payload did not include to[]", async () => {
    const { prisma, service, row } = setup();
    prisma.emailProviderEvent.findMany.mockResolvedValue([
      { type: "email.complained" },
    ] as never);
    await service.finish(
      { ...row, recipientHash: "recipient-hash" },
      { sent: true, providerMessageId: "provider" },
      { to: "x@y.com", subject: "Hi", text: "Hi" },
    );
    expect(prisma.emailSuppression.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { recipientHash: "recipient-hash" },
        create: { recipientHash: "recipient-hash", reason: "complaint" },
      }),
    );
  });

  it("reconciles a complaint committed while the provider ID is being bound", async () => {
    const { prisma, service, row } = setup();
    const committed: { type: string }[] = [];
    prisma.emailDelivery.updateMany.mockImplementationOnce(async () => {
      committed.push({ type: "email.complained" });
      return { count: 1 };
    });
    prisma.emailProviderEvent.findMany.mockImplementation(
      async () => committed as never,
    );
    await service.finish(
      row,
      { sent: true, providerMessageId: "provider" },
      { to: "x@y.com", subject: "Hi", text: "Hi" },
    );
    expect(prisma.emailSuppression.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { recipientHash: "recipient-hash" } }),
    );
    expect(prisma.emailDelivery.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "complained" }),
      }),
    );
  });

  it("never downgrades a concurrent complaint when reconciling a bounce snapshot", async () => {
    const { prisma, service } = setup();
    prisma.emailProviderEvent.findMany.mockResolvedValue([
      { type: "email.bounced" },
    ] as never);
    await service.reconcileProviderEvents("provider");
    expect(prisma.emailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "delivery", status: { notIn: ["complained"] } },
        data: expect.objectContaining({ status: "bounced" }),
      }),
    );
  });

  it("retains embedded photos without retaining security links or recipient content", () => {
    expect(
      emailMediaUrls(
        '<img src="https://cdn.example/photo.webp?a=1&amp;b=2"><a href="https://site/verify?token=secret">Confirm</a>',
      ),
    ).toEqual(["https://cdn.example/photo.webp?a=1&b=2"]);
  });
});
