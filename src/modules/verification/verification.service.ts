import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Prisma, VerificationRequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { UsersRealtimeService } from '../users/users-realtime.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';

@Injectable()
export class VerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersRealtime: UsersRealtimeService,
    private readonly presenceRealtime: PresenceRealtimeService,
  ) {}

  async createRequestForUser(params: { userId: string | null; providerHint: string | null }) {
    const userId = (params.userId ?? '').trim();
    if (!userId) throw new UnauthorizedException();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, verifiedStatus: true },
    });
    if (!user) throw new UnauthorizedException();
    if ((user.verifiedStatus ?? 'none') !== 'none') {
      throw new BadRequestException('You are already verified.');
    }

    // Prevent spam: return an existing pending request if one exists.
    const existingPending = await this.prisma.verificationRequest.findFirst({
      where: { userId, status: 'pending' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (existingPending) return existingPending;

    const provider = params.providerHint ? params.providerHint.trim().slice(0, 50) : null;

    return await this.prisma.verificationRequest.create({
      data: {
        user: { connect: { id: userId } },
        status: 'pending',
        provider: provider || null,
      },
    });
  }

  async getMyVerificationStatus(params: { userId: string | null }) {
    const userId = (params.userId ?? '').trim();
    if (!userId) throw new UnauthorizedException();

    const [user, latest] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { verifiedStatus: true, verifiedAt: true, unverifiedAt: true },
      }),
      this.prisma.verificationRequest.findFirst({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          createdAt: true,
          updatedAt: true,
          status: true,
          provider: true,
          providerRequestId: true,
          reviewedAt: true,
          rejectionReason: true,
        },
      }),
    ]);

    if (!user) throw new UnauthorizedException();

    return {
      verifiedStatus: user.verifiedStatus ?? 'none',
      verifiedAt: user.verifiedAt ? user.verifiedAt.toISOString() : null,
      unverifiedAt: user.unverifiedAt ? user.unverifiedAt.toISOString() : null,
      latestRequest: latest
        ? {
            id: latest.id,
            createdAt: latest.createdAt.toISOString(),
            updatedAt: latest.updatedAt.toISOString(),
            status: latest.status,
            provider: latest.provider ?? null,
            providerRequestId: latest.providerRequestId ?? null,
            reviewedAt: latest.reviewedAt ? latest.reviewedAt.toISOString() : null,
            rejectionReason: latest.rejectionReason ?? null,
          }
        : null,
    };
  }

  async listAdmin(params: {
    limit: number;
    cursor: string | null;
    status?: VerificationRequestStatus;
    q?: string;
  }) {
    const cursorWhere = await createdAtIdCursorWhere({
      cursor: params.cursor,
      lookup: async (id) =>
        this.prisma.verificationRequest.findUnique({
          where: { id },
          select: { id: true, createdAt: true },
        }),
    });

    const whereParts: Prisma.VerificationRequestWhereInput[] = [];
    if (cursorWhere) whereParts.push(cursorWhere);
    if (params.status) whereParts.push({ status: params.status });

    const q = (params.q ?? '').trim();
    if (q) {
      whereParts.push({
        OR: [
          { providerRequestId: { contains: q, mode: 'insensitive' } },
          { provider: { contains: q, mode: 'insensitive' } },
          {
            user: {
              OR: [
                { username: { contains: q, mode: 'insensitive' } },
                { name: { contains: q, mode: 'insensitive' } },
                { phone: { contains: q } },
                { email: { contains: q, mode: 'insensitive' } },
              ],
            },
          },
        ],
      });
    }

    const where = whereParts.length ? { AND: whereParts } : undefined;

    const rows = await this.prisma.verificationRequest.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: params.limit + 1,
      include: {
        user: true,
        reviewedByAdmin: { select: { id: true, username: true, name: true } },
      },
    });

    const slice = rows.slice(0, params.limit);
    const nextCursor = rows.length > params.limit ? slice[slice.length - 1]?.id ?? null : null;

    return { rows: slice, nextCursor };
  }

  async approveAdmin(params: { requestId: string; adminUserId: string; adminNote?: string | null }) {
    const id = (params.requestId ?? '').trim();
    if (!id) throw new NotFoundException('Verification request not found.');

    const now = new Date();

    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.verificationRequest.findUnique({
        where: { id },
        include: { user: { select: { id: true, verifiedStatus: true } } },
      });
      if (!existing) throw new NotFoundException('Verification request not found.');
      if (existing.status !== 'pending') throw new BadRequestException('This verification request is not pending.');
      if ((existing.user.verifiedStatus ?? 'none') !== 'none') {
        throw new BadRequestException('User is already verified.');
      }

      const updated = await tx.verificationRequest.update({
        where: { id },
        data: {
          status: 'approved',
          provider: 'manual',
          reviewedAt: now,
          reviewedByAdmin: { connect: { id: params.adminUserId } },
          adminNote: params.adminNote ?? null,
          rejectionReason: null,
        },
        include: {
          user: true,
          reviewedByAdmin: { select: { id: true, username: true, name: true } },
        },
      });

      await tx.user.update({
        where: { id: updated.userId },
        data: {
          verifiedStatus: 'manual',
          verifiedAt: now,
          unverifiedAt: null,
        },
      });

      return updated;
    });

    // Realtime: admin cross-tab sync + user/follower tier updates.
    try {
      this.presenceRealtime.emitAdminUpdated(params.adminUserId, {
        kind: 'verification',
        action: 'reviewed',
        id: updated.id,
      });
      const profile = await this.usersRealtime.getPublicProfileDtoByUserId(updated.userId);
      if (profile) {
        const related = await this.usersRealtime.listRelatedUserIds(updated.userId);
        const recipients = new Set<string>([updated.userId, ...related].filter(Boolean));
        this.presenceRealtime.emitUsersSelfUpdated(recipients, { user: profile });
      }
    } catch {
      // Best-effort
    }

    return updated;
  }

  async rejectAdmin(params: { requestId: string; adminUserId: string; rejectionReason: string; adminNote?: string | null }) {
    const id = (params.requestId ?? '').trim();
    if (!id) throw new NotFoundException('Verification request not found.');

    const reason = (params.rejectionReason ?? '').trim();
    if (!reason) throw new BadRequestException('Rejection reason is required.');

    const now = new Date();

    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.verificationRequest.findUnique({
        where: { id },
      });
      if (!existing) throw new NotFoundException('Verification request not found.');
      if (existing.status !== 'pending') throw new BadRequestException('This verification request is not pending.');

      return await tx.verificationRequest.update({
        where: { id },
        data: {
          status: 'rejected',
          reviewedAt: now,
          reviewedByAdmin: { connect: { id: params.adminUserId } },
          adminNote: params.adminNote ?? null,
          rejectionReason: reason,
        },
        include: {
          user: true,
          reviewedByAdmin: { select: { id: true, username: true, name: true } },
        },
      });
    });

    // Realtime: admin cross-tab sync (self only).
    try {
      this.presenceRealtime.emitAdminUpdated(params.adminUserId, {
        kind: 'verification',
        action: 'reviewed',
        id: updated.id,
      });
    } catch {
      // Best-effort
    }

    return updated;
  }
}

