import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { XMonthlyAllowanceDto } from "../partner/partner.dto";

export function xMonth(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
export function xMonthlyAllowance(
  verified: boolean,
  premium: boolean,
  total: number,
  links: number,
  now = new Date(),
): XMonthlyAllowanceDto {
  const totalLimit = verified ? (premium ? 300 : 50) : 0;
  const linkLimit = verified ? (premium ? 20 : 3) : 0;
  const totalRemaining = Math.max(0, totalLimit - total);
  const linkRemaining = Math.min(
    totalRemaining,
    Math.max(0, linkLimit - links),
  );
  return {
    totalLimit,
    linkLimit,
    totalRemaining,
    linkRemaining,
    nativePostsLeft: totalRemaining,
    linkPostsLeft: linkRemaining,
    resetsAt: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ).toISOString(),
  };
}
@Injectable()
export class XUsageService {
  constructor(private readonly prisma: PrismaService) {}
  async allowance(
    userId: string,
    externalAccountId?: string,
    now = new Date(),
  ) {
    const [user, rows] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          verifiedStatus: true,
          premium: true,
          premiumPlus: true,
          bannedAt: true,
        },
      }),
      this.prisma.xUsageReservation.findMany({
        where: {
          month: xMonth(now),
          status: { not: "released" },
          OR: [
            { userId },
            ...(externalAccountId ? [{ externalAccountId }] : []),
          ],
        },
        select: { hasLink: true },
      }),
    ]);
    return xMonthlyAllowance(
      Boolean(user && !user.bannedAt && user.verifiedStatus !== "none"),
      Boolean(user?.premium || user?.premiumPlus),
      rows.length,
      rows.filter((r) => r.hasLink).length,
      now,
    );
  }
  async reserve(
    id: string,
    userId: string,
    externalAccountId: string,
    hasLink: boolean,
    now = new Date(),
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // Lock both identities in a stable order; pages never charge individual operators.
      for (const key of [
        `x-account:${userId}`,
        `x-external:${externalAccountId}`,
      ].sort())
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      const existing = await tx.xUsageReservation.findUnique({ where: { id } });
      if (existing && existing.status !== "released")
        return (
          existing.userId === userId &&
          existing.externalAccountId === externalAccountId
        );
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          verifiedStatus: true,
          premium: true,
          premiumPlus: true,
          bannedAt: true,
        },
      });
      const rows = await tx.xUsageReservation.findMany({
        where: {
          month: xMonth(now),
          status: { not: "released" },
          OR: [{ userId }, { externalAccountId }],
        },
        select: { hasLink: true },
      });
      const a = xMonthlyAllowance(
        Boolean(user && !user.bannedAt && user.verifiedStatus !== "none"),
        Boolean(user?.premium || user?.premiumPlus),
        rows.length,
        rows.filter((r) => r.hasLink).length,
        now,
      );
      if (!a.totalRemaining || (hasLink && !a.linkRemaining)) return false;
      const data = {
        userId,
        externalAccountId,
        hasLink,
        month: xMonth(now),
        status: "reserved",
      };
      await tx.xUsageReservation.upsert({
        where: { id },
        create: { id, ...data },
        update: data,
      });
      return true;
    });
  }
  /** Rollback compatibility only; the shared ledger already authorized this send. */
  async recordShared(
    id: string,
    userId: string,
    externalAccountId: string,
    hasLink: boolean,
  ) {
    await this.prisma.xUsageReservation.upsert({
      where: { id },
      update: {},
      create: {
        id,
        userId,
        externalAccountId,
        hasLink,
        month: xMonth(),
        status: "reserved",
      },
    });
  }
  async settle(id: string, status: "sent" | "uncertain" | "released") {
    await this.prisma.xUsageReservation.updateMany({
      where: { id, status: { in: ["reserved", "uncertain"] } },
      data: { status },
    });
  }
}
