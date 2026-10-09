import { Injectable } from "@nestjs/common";
import { Prisma, type EmailDelivery } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { EmailPreferencesService } from "./email-preferences.service";
import type { SendEmailParams } from "./email-delivery.types";
import type { EmailSendResult } from "./providers/email-provider";

const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 6;
const TERMINAL = [
  "sent",
  "delivered",
  "bounced",
  "complained",
  "failed",
  "suppressed",
];

/** Retains only embedded media URLs after the recipient/body retry payload is erased. */
export function emailMediaUrls(html: string | null | undefined): string[] {
  return [
    ...new Set(
      Array.from(
        (html ?? "").matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi),
        (match) => match[1].replace(/&amp;/g, "&"),
      ),
    ),
  ];
}

export function emailPayloadFingerprint(request: SendEmailParams): string {
  const headers = Object.entries(request.headers ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        to: request.to.trim(),
        subject: request.subject.trim(),
        text: request.text.trim(),
        html: request.html?.trim() || null,
        from: request.from?.trim() || null,
        replyTo: request.replyTo?.trim() || null,
        headers,
      }),
    )
    .digest("hex");
}

@Injectable()
export class EmailDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly preferences: EmailPreferencesService,
  ) {}

  async alreadySent(eventKey: string | undefined): Promise<boolean> {
    if (!eventKey) return false;
    const row = await this.prisma.emailDelivery.findUnique({
      where: { eventKey },
      select: { status: true },
    });
    return !!row && ["sent", "delivered"].includes(row.status);
  }

  async prepare(request: SendEmailParams): Promise<EmailDelivery> {
    const eventKey = request.eventKey ?? `request:${randomUUID()}`;
    const serialized = JSON.stringify({ ...request, eventKey });
    return this.prisma.emailDelivery.upsert({
      where: { eventKey },
      update: {},
      create: {
        eventKey,
        userId: request.userId,
        recipientHash: this.preferences.recipientHash(request.to),
        category: request.category ?? "engagement",
        preference: request.preference,
        requestJson: serialized,
        retrySafe:
          request.retrySafe ??
          (request.category === "transactional" &&
            request.recipientMode !== "verification"),
        mediaUrls: emailMediaUrls(request.html),
        retryUntil: new Date(Date.now() + RETRY_WINDOW_MS),
      },
    });
  }

  async claim(row: EmailDelivery): Promise<boolean> {
    const now = new Date();
    if (TERMINAL.includes(row.status)) return false;
    const result = await this.prisma.emailDelivery.updateMany({
      where: {
        id: row.id,
        attempts: { lt: MAX_ATTEMPTS },
        retryUntil: { gt: now },
        status: { notIn: TERMINAL },
        nextAttemptAt: { lte: now },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data: {
        leaseUntil: new Date(Date.now() + 60_000),
        status: "sending",
        attempts: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  providerKey(row: EmailDelivery): string {
    return `moh-email-${createHash("sha256").update(row.eventKey).digest("hex")}`;
  }

  async finish(
    row: EmailDelivery,
    result: EmailSendResult,
    _request: SendEmailParams,
  ): Promise<void> {
    if (result.sent) {
      // Publish the provider ID before reading receipts. A webhook that commits
      // after this bind also reconciles after its own commit.
      await this.prisma.emailDelivery.updateMany({
        where: { id: row.id, status: "sending" },
        data: {
          status: "sent",
          providerMessageId: result.providerMessageId,
          sentAt: new Date(),
          leaseUntil: null,
          requestJson: null,
        },
      });
      if (result.providerMessageId)
        await this.reconcileProviderEvents(result.providerMessageId);
      return;
    }
    const quota =
      result.reason.startsWith("email_quota_") ||
      result.reason === "email_per_user_engagement_cap";
    const retry =
      result.retryable &&
      (quota || row.attempts + 1 < MAX_ATTEMPTS) &&
      row.retryUntil.getTime() > Date.now();
    await this.prisma.emailDelivery.update({
      where: { id: row.id },
      data: {
        status: retry
          ? "pending"
          : result.reason.startsWith("email_suppressed")
            ? "suppressed"
            : "failed",
        lastError: result.reason,
        leaseUntil: null,
        ...(quota ? { attempts: { decrement: 1 } } : {}),
        nextAttemptAt: new Date(
          Date.now() +
            (quota
              ? 60 * 60_000
              : Math.min(60_000 * 2 ** row.attempts, 60 * 60_000)),
        ),
        ...(!retry ? { requestJson: null } : {}),
      },
    });
  }

  async reconcileProviderEvents(messageId: string): Promise<void> {
    const row = await this.prisma.emailDelivery.findUnique({
      where: { providerMessageId: messageId },
    });
    if (!row) return;
    const events = await this.prisma.emailProviderEvent.findMany({
      where: { messageId },
    });
    const status = events.some((event) => event.type === "email.complained")
      ? "complained"
      : events.some((event) => event.type === "email.bounced")
        ? "bounced"
        : events.some((event) => event.type === "email.delivered")
          ? "delivered"
          : null;
    if (!status) return;
    if (status === "bounced" || status === "complained")
      await this.suppress(
        row.recipientHash,
        status === "complained" ? "complaint" : "bounce",
      );
    // A receipt may commit after the query above. Conditional updates preserve
    // stronger terminal receipts even when delivered/bounced snapshots are stale.
    const protectedStatuses =
      status === "delivered"
        ? ["bounced", "complained"]
        : status === "bounced"
          ? ["complained"]
          : [];
    await this.prisma.emailDelivery.updateMany({
      where: {
        id: row.id,
        ...(protectedStatuses.length
          ? { status: { notIn: protectedStatuses } }
          : {}),
      },
      data: {
        status,
        ...(status === "delivered" ? { deliveredAt: new Date() } : {}),
        requestJson: null,
        leaseUntil: null,
      },
    });
  }

  async due(): Promise<EmailDelivery[]> {
    const now = new Date();
    // Expired uncertain sends must never replay beyond the provider's 24h idempotency window.
    await this.prisma.emailDelivery.updateMany({
      where: {
        status: { in: ["pending", "sending"] },
        retryUntil: { lte: now },
      },
      data: {
        status: "failed",
        requestJson: null,
        leaseUntil: null,
        lastError: "email_retry_expired",
      },
    });
    return this.prisma.emailDelivery.findMany({
      where: {
        retrySafe: true,
        status: { in: ["pending", "sending"] },
        nextAttemptAt: { lte: now },
        retryUntil: { gt: now },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      orderBy: [{ category: "desc" }, { nextAttemptAt: "asc" }],
      take: 50,
    });
  }

  async suppress(
    recipientHash: string,
    reason: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await db.emailSuppression.upsert({
      where: { recipientHash },
      create: { recipientHash, reason },
      update: { reason },
    });
  }
}
