import { createHmac } from "node:crypto";
import {
  EmailWebhookService,
  verifyResendSignature,
} from "./email-webhook.service";

const secretBytes = Buffer.from("test-signing-key");
const secret = `whsec_${secretBytes.toString("base64")}`;
function signed(raw: Buffer, time = Date.now()) {
  const timestamp = String(Math.floor(time / 1000));
  const id = "msg-id";
  return {
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${createHmac("sha256", secretBytes).update(`${id}.${timestamp}.`).update(raw).digest("base64")}`,
  };
}

describe("signed Resend delivery events", () => {
  it("verifies exact bytes, supports rotated signatures, and rejects replay or forged bodies", () => {
    const raw = Buffer.from(
      '{"type":"email.delivered","data":{"email_id":"provider"}}',
    );
    const headers = signed(raw);
    expect(() =>
      verifyResendSignature(
        raw,
        {
          ...headers,
          "svix-signature": `v1,invalid ${headers["svix-signature"]}`,
        },
        secret,
      ),
    ).not.toThrow();
    expect(() =>
      verifyResendSignature(Buffer.from(raw.toString() + " "), headers, secret),
    ).toThrow("Invalid email webhook");
    expect(() =>
      verifyResendSignature(raw, signed(raw, Date.now() - 301000), secret),
    ).toThrow("Invalid email webhook");
    expect(() =>
      verifyResendSignature(raw, signed(raw, Date.now() + 301000), secret),
    ).toThrow("Invalid email webhook");
  });

  function setup() {
    const tx = {
      emailProviderEvent: { create: jest.fn() },
      emailDelivery: {
        findUnique: jest.fn(async () => ({
          id: "delivery",
          recipientHash: "stored-hash",
          status: "sent",
        })),
        update: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (run: (db: unknown) => unknown) => run(tx)),
    };
    const delivery = {
      suppress: jest.fn(),
      reconcileProviderEvents: jest.fn(),
    };
    const config = { emailWebhookSecret: () => secret };
    const service = new EmailWebhookService(
      config as never,
      prisma as never,
      delivery as never,
      { recipientHash: (to: string) => `hash:${to}` } as never,
    );
    return { service, tx, delivery, prisma };
  }

  it("commits complaint suppression and event deduplication together", async () => {
    const { service, tx, delivery } = setup();
    const raw = Buffer.from(
      JSON.stringify({
        type: "email.complained",
        data: { email_id: "provider", to: ["member@example.com"] },
      }),
    );
    await expect(service.receive(raw, signed(raw))).resolves.toEqual({
      ok: true,
    });
    expect(tx.emailProviderEvent.create).toHaveBeenCalledWith({
      data: { id: "msg-id", type: "email.complained", messageId: "provider" },
    });
    expect(delivery.suppress).toHaveBeenCalledWith(
      "stored-hash",
      "complaint",
      tx,
    );
    expect(delivery.reconcileProviderEvents).toHaveBeenCalledWith("provider");
  });

  it("suppresses a final bounce even when the receipt precedes saving the provider message ID", async () => {
    const { service, tx, delivery } = setup();
    tx.emailDelivery.findUnique.mockResolvedValue(null as never);
    const raw = Buffer.from(
      JSON.stringify({
        type: "email.bounced",
        data: { email_id: "provider", to: ["member@example.com"] },
      }),
    );
    await service.receive(raw, signed(raw));
    expect(delivery.suppress).toHaveBeenCalledWith(
      "hash:member@example.com",
      "bounce",
      tx,
    );
  });

  it("does not allow a late delivered event to overwrite a complaint", async () => {
    const { service, tx } = setup();
    tx.emailDelivery.findUnique.mockResolvedValue({
      id: "delivery",
      recipientHash: "stored-hash",
      status: "complained",
    });
    const raw = Buffer.from(
      JSON.stringify({
        type: "email.delivered",
        data: { email_id: "provider" },
      }),
    );
    await service.receive(raw, signed(raw));
    expect(tx.emailDelivery.update).not.toHaveBeenCalled();
  });

  it("reconciles after commit when the provider ID bind overlaps its transaction", async () => {
    const { service, tx, delivery, prisma } = setup();
    let committed = false;
    tx.emailDelivery.findUnique.mockResolvedValue(null as never);
    prisma.$transaction.mockImplementation(async (run) => {
      const result = await run(tx);
      committed = true;
      return result;
    });
    delivery.reconcileProviderEvents.mockImplementation(async (messageId) => {
      expect(committed).toBe(true);
      expect(messageId).toBe("provider");
    });
    const raw = Buffer.from(
      JSON.stringify({
        type: "email.complained",
        data: { email_id: "provider" },
      }),
    );
    await service.receive(raw, signed(raw));
    expect(delivery.reconcileProviderEvents).toHaveBeenCalledTimes(1);
  });

  it("fails closed when signing configuration or raw body is missing", async () => {
    const { service, prisma } = setup();
    await expect(service.receive(undefined, {})).rejects.toThrow("raw body");
    const unconfigured = new EmailWebhookService(
      { emailWebhookSecret: () => null } as never,
      prisma as never,
      {} as never,
      {} as never,
    );
    await expect(unconfigured.receive(Buffer.from("{}"), {})).rejects.toThrow(
      "not configured",
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
