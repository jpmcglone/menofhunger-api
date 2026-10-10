import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { AuthedRequest } from "../auth/auth-public-api";
import { PrismaService } from "../prisma/prisma.service";
import { FcmMessagingProvider } from "./fcm-messaging.provider";
import { checkinSchedule } from "../checkins/checkin-schedule";
import {
  isSerializationFailure,
  isUniqueViolation,
} from "../../common/prisma/errors";
import { NOT_BANNED_USER_WHERE } from "../../common/prisma-selects/user.where";
import type {
  FcmPushPayloadDto,
  FcmRegisterRequestDto,
  FcmRegistrationDto,
  FcmUnregisterRequestDto,
} from "../../common/dto/fcm-device.dto";

const PUSH_TTL_MS = 60 * 60_000;
const PRUNE_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

/** Session/install bindings are uncached so revoked sessions cannot continue receiving pushes. */
@Injectable()
export class FcmPushService {
  private readonly logger = new Logger(FcmPushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: FcmMessagingProvider,
  ) {}

  configured(): boolean {
    return this.messaging.configured();
  }

  private identity(user: AuthedRequest["user"]): {
    userId: string;
    sessionId: string;
  } {
    if (
      !user?.sessionId ||
      user.impersonatedByUserId ||
      user.operatedByUserId ||
      user.accountKind !== "person"
    ) {
      throw new ForbiddenException(
        "Device registration requires your own personal session.",
      );
    }
    return { userId: user.id, sessionId: user.sessionId };
  }

  private eligibleSession(
    userId: string,
    sessionId?: string,
  ): Prisma.SessionWhereInput {
    return {
      ...(sessionId ? { id: sessionId } : {}),
      userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      impersonatedByUserId: null,
      operatedByUserId: null,
      user: {
        accountKind: "person",
        ...NOT_BANNED_USER_WHERE,
        deletionScheduledAt: null,
      },
    };
  }

  async register(
    user: AuthedRequest["user"],
    input: FcmRegisterRequestDto,
  ): Promise<FcmRegistrationDto> {
    const { userId, sessionId } = this.identity(user);
    // Retry serialization/uniqueness conflicts caused by concurrent token refreshes.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const session = await tx.session.findFirst({
              where: this.eligibleSession(userId, sessionId),
              select: { id: true },
            });
            if (!session)
              throw new ForbiddenException(
                "This session cannot register a device.",
              );
            const previous = await tx.fcmDeviceRegistration.findUnique({
              where: { installationId: input.installationId },
            });
            const bindingId =
              previous?.userId === userId &&
              previous.sessionId === sessionId &&
              previous.token === input.token
                ? previous.bindingId
                : randomUUID();
            // A rotated/reinstalled token can never remain bound to two installations/accounts.
            await tx.fcmDeviceRegistration.deleteMany({
              where: {
                token: input.token,
                NOT: { installationId: input.installationId },
              },
            });
            const data = {
              userId,
              sessionId,
              token: input.token,
              bindingId,
              notificationsEnabled: input.notificationsEnabled,
              lastSeenAt: new Date(),
            };
            await tx.fcmDeviceRegistration.upsert({
              where: { installationId: input.installationId },
              create: { installationId: input.installationId, ...data },
              update: data,
            });
            return { bindingId };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (
          attempt >= 2 ||
          (!isSerializationFailure(error) && !isUniqueViolation(error))
        ) {
          if (error instanceof ForbiddenException) throw error;
          throw new ServiceUnavailableException(
            "Device registration is unavailable.",
          );
        }
      }
    }
  }

  async unregister(
    user: AuthedRequest["user"],
    input: FcmUnregisterRequestDto,
  ): Promise<void> {
    const { userId, sessionId } = this.identity(user);
    // A delayed logout/token cleanup cannot remove a replacement account's binding.
    try {
      await this.prisma.fcmDeviceRegistration.deleteMany({
        where: { ...input, userId, sessionId },
      });
    } catch {
      throw new ServiceUnavailableException(
        "Device registration is unavailable.",
      );
    }
  }

  async hasTokens(userId: string): Promise<boolean> {
    return Boolean(
      await this.prisma.fcmDeviceRegistration.count({
        where: {
          userId,
          notificationsEnabled: true,
          session: this.eligibleSession(userId),
        },
      }),
    );
  }

  async sendToUser(
    userId: string,
    params: {
      recipientUserId: string;
      eventId: string;
      kind: string;
      destination: string;
      tag: string;
      canDeliver?: () => Promise<boolean>;
    },
  ): Promise<void> {
    try {
      await this.deliverToUser(userId, params);
    } catch {
      throw new Error("FCM delivery unavailable");
    }
  }

  private async deliverToUser(
    userId: string,
    params: {
      recipientUserId: string;
      eventId: string;
      kind: string;
      destination: string;
      tag: string;
      canDeliver?: () => Promise<boolean>;
    },
  ): Promise<void> {
    // Android v1 has personal identities only; do not send page destinations to personal bindings.
    if (!this.configured() || userId !== params.recipientUserId) return;
    if (
      !params.destination.startsWith("/") ||
      params.destination.startsWith("//") ||
      params.destination.includes("\\")
    )
      return;
    const registrations = await this.prisma.fcmDeviceRegistration.findMany({
      where: {
        userId,
        notificationsEnabled: true,
        session: this.eligibleSession(userId),
      },
      select: { id: true, bindingId: true, token: true },
    });
    const now = new Date();
    const schedule =
      params.kind === "checkin_reminder" ? checkinSchedule(now) : null;
    if (schedule && !schedule.isOpen) return;
    const deadline = Math.min(
      now.getTime() + PUSH_TTL_MS,
      schedule ? Date.parse(schedule.closesAt) : Number.POSITIVE_INFINITY,
    );
    const expiresAt = new Date(deadline).toISOString();
    for (const registration of registrations) {
      if (params.canDeliver && !(await params.canDeliver())) return;
      // Re-read this exact binding immediately before sending. Never trust a fanout/cache snapshot.
      const eligible = await this.prisma.fcmDeviceRegistration.findFirst({
        where: {
          id: registration.id,
          bindingId: registration.bindingId,
          token: registration.token,
          userId,
          notificationsEnabled: true,
          session: this.eligibleSession(userId),
        },
        select: { id: true },
      });
      if (!eligible) continue;
      const ttl = deadline - Date.now();
      if (ttl <= 0) return;
      const payload: FcmPushPayloadDto = {
        schemaVersion: "1",
        bindingId: registration.bindingId,
        recipientUserId: params.recipientUserId,
        eventId: params.eventId,
        kind: params.kind,
        destination: params.destination,
        expiresAt,
        tag: params.tag,
        title: params.kind === "message" ? "New message" : "Men of Hunger",
        body:
          params.kind === "message"
            ? "Open Men of Hunger to read your message."
            : "Open Men of Hunger to view new activity.",
      };
      try {
        // No `notification` field: Android must authorize and render locally, including in background.
        await this.messaging.send({
          token: registration.token,
          data: payload,
          android: {
            priority:
              params.kind === "message" || params.kind.includes("call")
                ? "high"
                : "normal",
            ttl,
          },
        });
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code && PRUNE_CODES.has(code)) {
          // A late invalid-token response must not delete a newly rotated binding.
          await this.prisma.fcmDeviceRegistration.deleteMany({
            where: {
              id: registration.id,
              bindingId: registration.bindingId,
              token: registration.token,
            },
          });
        } else {
          // Never log tokens, payloads, credentials, or provider error messages.
          this.logger.warn("FCM delivery failed");
          if (params.canDeliver) throw error;
        }
      }
    }
  }
}
