import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CrewOwnerTransferVote } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CREW_INACTIVE_OWNER_DAYS,
  CREW_TRANSFER_VOTE_EXPIRY_DAYS,
} from '../../common/dto/crew.dto';
import { CrewService } from './crew.service';

export type TransferReason = 'direct' | 'vote' | 'inactivity';

@Injectable()
export class CrewTransferService {
  private readonly logger = new Logger(CrewTransferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly notifications: NotificationsService,
    private readonly crew: CrewService,
  ) {}

  // ---------- direct transfer (owner → member) ----------

  async directTransfer(params: {
    viewerUserId: string;
    newOwnerUserId: string;
  }): Promise<void> {
    await this.crew.assertVerified(params.viewerUserId);
    const mem = await this.prisma.crewMember.findUnique({
      where: { userId: params.viewerUserId },
    });
    if (!mem) throw new NotFoundException('You are not in a crew.');
    await this.crew.assertCrewOwner(mem.crewId, params.viewerUserId);
    if (params.newOwnerUserId === params.viewerUserId) {
      throw new BadRequestException('You are already the owner.');
    }
    const target = await this.prisma.crewMember.findUnique({
      where: { crewId_userId: { crewId: mem.crewId, userId: params.newOwnerUserId } },
    });
    if (!target) throw new NotFoundException('Target must be a member of your crew.');

    await this.applyTransfer({
      crewId: mem.crewId,
      previousOwnerUserId: params.viewerUserId,
      newOwnerUserId: params.newOwnerUserId,
      reason: 'direct',
    });
  }

  // ---------- vote (non-owners) ----------

  async openTransferVote(params: {
    viewerUserId: string;
    targetUserId: string;
  }): Promise<CrewOwnerTransferVote> {
    await this.crew.assertVerified(params.viewerUserId);
    const mem = await this.prisma.crewMember.findUnique({
      where: { userId: params.viewerUserId },
    });
    if (!mem) throw new NotFoundException('You are not in a crew.');
    if (mem.role === 'owner') {
      throw new BadRequestException('Owners cannot open a transfer vote.');
    }
    const crewId = mem.crewId;

    const target = await this.prisma.crewMember.findUnique({
      where: { crewId_userId: { crewId, userId: params.targetUserId } },
    });
    if (!target || target.role === 'owner') {
      throw new BadRequestException('Target must be a non-owner member of your crew.');
    }

    const existingOpen = await this.prisma.crewOwnerTransferVote.findFirst({
      where: { crewId, status: 'open' },
    });
    if (existingOpen) {
      throw new ConflictException('A transfer vote is already in progress.');
    }

    const expiresAt = new Date();
    expiresAt.setUTCDate(expiresAt.getUTCDate() + CREW_TRANSFER_VOTE_EXPIRY_DAYS);

    const vote = await this.prisma.$transaction(async (tx) => {
      const created = await tx.crewOwnerTransferVote.create({
        data: {
          crewId,
          proposerUserId: params.viewerUserId,
          targetUserId: params.targetUserId,
          expiresAt,
          status: 'open',
        },
      });
      // Proposer's ballot is recorded as yes.
      await tx.crewOwnerTransferBallot.create({
        data: { voteId: created.id, userId: params.viewerUserId, inFavor: true },
      });
      return created;
    });

    // Notify all non-owner members (except proposer).
    const nonOwners = await this.prisma.crewMember.findMany({
      where: { crewId, role: 'member' },
      select: { userId: true },
    });
    for (const nm of nonOwners) {
      if (nm.userId === params.viewerUserId) continue;
      await this.notifications.create({
        recipientUserId: nm.userId,
        kind: 'crew_owner_transfer_vote',
        actorUserId: params.viewerUserId,
        subjectCrewId: crewId,
      });
    }
    const memberIds = await this.prisma.crewMember
      .findMany({ where: { crewId }, select: { userId: true } })
      .then((rs) => rs.map((r) => r.userId));
    this.presenceRealtime.emitCrewTransferVote(memberIds, {
      crewId,
      vote: { id: vote.id, status: vote.status, targetUserId: vote.targetUserId, expiresAt: vote.expiresAt.toISOString() },
    });

    // If the crew has exactly 2 members, the proposer is the only non-owner and
    // a single yes ballot already passes the vote.
    await this.maybeResolveVote(vote.id);

    return vote;
  }

  async castBallot(params: {
    viewerUserId: string;
    voteId: string;
    inFavor: boolean;
  }): Promise<void> {
    await this.crew.assertVerified(params.viewerUserId);
    const vote = await this.prisma.crewOwnerTransferVote.findUnique({
      where: { id: params.voteId },
    });
    if (!vote) throw new NotFoundException('Vote not found.');
    if (vote.status !== 'open') {
      throw new BadRequestException('Vote is no longer open.');
    }
    const mem = await this.prisma.crewMember.findUnique({
      where: { crewId_userId: { crewId: vote.crewId, userId: params.viewerUserId } },
    });
    if (!mem) throw new ForbiddenException('You are not a member of this crew.');
    if (mem.role === 'owner') {
      throw new ForbiddenException('Owners do not vote on transfer votes.');
    }
    await this.prisma.crewOwnerTransferBallot.upsert({
      where: { voteId_userId: { voteId: vote.id, userId: params.viewerUserId } },
      create: { voteId: vote.id, userId: params.viewerUserId, inFavor: params.inFavor },
      update: { inFavor: params.inFavor },
    });
    await this.maybeResolveVote(vote.id);
  }

  async cancelTransferVote(params: { viewerUserId: string; voteId: string }): Promise<void> {
    const vote = await this.prisma.crewOwnerTransferVote.findUnique({
      where: { id: params.voteId },
    });
    if (!vote) throw new NotFoundException('Vote not found.');
    if (vote.status !== 'open') return;
    if (vote.proposerUserId !== params.viewerUserId) {
      throw new ForbiddenException('Only the proposer can cancel a vote.');
    }
    await this.prisma.crewOwnerTransferVote.update({
      where: { id: vote.id },
      data: { status: 'cancelled', resolvedAt: new Date() },
    });
    const memberIds = await this.prisma.crewMember
      .findMany({ where: { crewId: vote.crewId }, select: { userId: true } })
      .then((rs) => rs.map((r) => r.userId));
    this.presenceRealtime.emitCrewTransferVote(memberIds, {
      crewId: vote.crewId,
      vote: { id: vote.id, status: 'cancelled' },
    });
  }

  /**
   * If all non-owner members have voted yes, promote the target and close the vote.
   * If any non-owner voted no, reject the vote. Otherwise leave open.
   */
  private async maybeResolveVote(voteId: string): Promise<void> {
    const vote = await this.prisma.crewOwnerTransferVote.findUnique({
      where: { id: voteId },
      include: { ballots: true },
    });
    if (!vote || vote.status !== 'open') return;

    const nonOwnerMembers = await this.prisma.crewMember.findMany({
      where: { crewId: vote.crewId, role: 'member' },
      select: { userId: true },
    });

    const noBallot = vote.ballots.find((b) => !b.inFavor);
    if (noBallot) {
      await this.prisma.crewOwnerTransferVote.update({
        where: { id: vote.id },
        data: { status: 'rejected', resolvedAt: new Date() },
      });
      const memberIds = await this.prisma.crewMember
        .findMany({ where: { crewId: vote.crewId }, select: { userId: true } })
        .then((rs) => rs.map((r) => r.userId));
      this.presenceRealtime.emitCrewTransferVote(memberIds, {
        crewId: vote.crewId,
        vote: { id: vote.id, status: 'rejected' },
      });
      return;
    }

    const yesSet = new Set(vote.ballots.filter((b) => b.inFavor).map((b) => b.userId));
    const allVotedYes = nonOwnerMembers.every((m) => yesSet.has(m.userId));
    if (!allVotedYes) return;

    // Target may have left or been kicked since the vote opened; double-check.
    const target = await this.prisma.crewMember.findUnique({
      where: { crewId_userId: { crewId: vote.crewId, userId: vote.targetUserId } },
      select: { userId: true, role: true },
    });
    const currentOwner = await this.prisma.crewMember.findFirst({
      where: { crewId: vote.crewId, role: 'owner' },
      select: { userId: true },
    });
    if (!target || !currentOwner || target.role === 'owner') {
      await this.prisma.crewOwnerTransferVote.update({
        where: { id: vote.id },
        data: { status: 'rejected', resolvedAt: new Date() },
      });
      return;
    }

    await this.applyTransfer({
      crewId: vote.crewId,
      previousOwnerUserId: currentOwner.userId,
      newOwnerUserId: target.userId,
      reason: 'vote',
    });

    await this.prisma.crewOwnerTransferVote.update({
      where: { id: vote.id },
      data: { status: 'passed', resolvedAt: new Date() },
    });
  }

  // ---------- inactivity auto-transfer ----------

  /**
   * Finds crews where the owner has not had any `UserDailyActivity` rows in the last
   * {@link CREW_INACTIVE_OWNER_DAYS} days and transfers ownership. Runs from cron.
   * Returns the number of crews rotated.
   */
  async autoTransferInactiveOwners(): Promise<number> {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - CREW_INACTIVE_OWNER_DAYS);

    // Collect candidate crews in small batches — we intentionally do not hold all crews
    // in memory even though the expected N is small.
    const crews = await this.prisma.crew.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        ownerUserId: true,
        designatedSuccessorUserId: true,
        createdAt: true,
      },
      take: 1000,
    });

    let rotated = 0;
    for (const c of crews) {
      const recentOwnerActivity = await this.prisma.userDailyActivity.findFirst({
        where: { userId: c.ownerUserId, day: { gte: cutoff } },
        select: { userId: true },
      });
      if (recentOwnerActivity) continue;

      // Confirm the owner hasn't just checked in through another signal (lastSeenAt) —
      // daily activity is the source of truth per spec, but this avoids flapping if the
      // cron runs before a daily row is flushed.
      const owner = await this.prisma.user.findUnique({
        where: { id: c.ownerUserId },
        select: { lastSeenAt: true, bannedAt: true },
      });
      if (owner?.bannedAt) {
        // banned owners should rotate regardless
      } else if (owner?.lastSeenAt && owner.lastSeenAt >= cutoff) {
        continue;
      }

      const successor = await this.pickInactivitySuccessor(c.id, c.ownerUserId, c.designatedSuccessorUserId);
      if (!successor) continue;

      try {
        await this.applyTransfer({
          crewId: c.id,
          previousOwnerUserId: c.ownerUserId,
          newOwnerUserId: successor,
          reason: 'inactivity',
        });
        rotated += 1;
      } catch (e) {
        this.logger.error(
          `auto-transfer failed for crew=${c.id}: ${(e as Error).message}`,
        );
      }
    }
    return rotated;
  }

  private async pickInactivitySuccessor(
    crewId: string,
    ownerUserId: string,
    designatedUserId: string | null,
  ): Promise<string | null> {
    if (designatedUserId) {
      const designated = await this.prisma.crewMember.findUnique({
        where: { crewId_userId: { crewId, userId: designatedUserId } },
        select: { userId: true, role: true },
      });
      if (designated && designated.role !== 'owner') return designated.userId;
    }
    // Longest-tenured non-owner member (earliest join date).
    const nonOwner = await this.prisma.crewMember.findFirst({
      where: { crewId, NOT: { userId: ownerUserId } },
      orderBy: [{ createdAt: 'asc' }],
      select: { userId: true },
    });
    return nonOwner?.userId ?? null;
  }

  // ---------- vote expiry job ----------

  async expireOpenVotes(): Promise<number> {
    const now = new Date();
    const expiring = await this.prisma.crewOwnerTransferVote.findMany({
      where: { status: 'open', expiresAt: { lte: now } },
      select: { id: true, crewId: true },
      take: 500,
    });
    if (expiring.length === 0) return 0;
    const ids = expiring.map((v) => v.id);
    const result = await this.prisma.crewOwnerTransferVote.updateMany({
      where: { id: { in: ids }, status: 'open' },
      data: { status: 'expired', resolvedAt: now },
    });
    for (const v of expiring) {
      const memberIds = await this.prisma.crewMember
        .findMany({ where: { crewId: v.crewId }, select: { userId: true } })
        .then((rs) => rs.map((r) => r.userId));
      this.presenceRealtime.emitCrewTransferVote(memberIds, {
        crewId: v.crewId,
        vote: { id: v.id, status: 'expired' },
      });
    }
    return result.count;
  }

  // ---------- admin override ----------

  /**
   * Force-transfer ownership without owner consent. Intended for admin tools only —
   * call sites MUST gate on siteAdmin themselves.
   */
  async adminForceTransfer(params: {
    crewId: string;
    newOwnerUserId: string;
  }): Promise<void> {
    const crew = await this.prisma.crew.findUnique({
      where: { id: params.crewId },
      select: { id: true, deletedAt: true, ownerUserId: true },
    });
    if (!crew || crew.deletedAt) throw new NotFoundException('Crew not found.');
    const target = await this.prisma.crewMember.findUnique({
      where: { crewId_userId: { crewId: crew.id, userId: params.newOwnerUserId } },
    });
    if (!target) {
      throw new BadRequestException('Target must be a member of this crew.');
    }
    if (target.role === 'owner') return;
    await this.applyTransfer({
      crewId: crew.id,
      previousOwnerUserId: crew.ownerUserId,
      newOwnerUserId: params.newOwnerUserId,
      reason: 'direct',
    });
  }

  // ---------- shared ownership swap ----------

  private async applyTransfer(params: {
    crewId: string;
    previousOwnerUserId: string;
    newOwnerUserId: string;
    reason: TransferReason;
  }): Promise<void> {
    const { crewId, previousOwnerUserId, newOwnerUserId, reason } = params;
    if (previousOwnerUserId === newOwnerUserId) return;

    try {
      await this.prisma.$transaction(async (tx) => {
        // Demote current owner.
        await tx.crewMember.update({
          where: { crewId_userId: { crewId, userId: previousOwnerUserId } },
          data: { role: 'member' },
        });
        // Promote new owner.
        await tx.crewMember.update({
          where: { crewId_userId: { crewId, userId: newOwnerUserId } },
          data: { role: 'owner' },
        });
        // Update crew pointer + clear successor (new owner picks their own).
        await tx.crew.update({
          where: { id: crewId },
          data: {
            ownerUserId: newOwnerUserId,
            designatedSuccessorUserId: null,
          },
        });
        // Any open transfer votes become moot.
        await tx.crewOwnerTransferVote.updateMany({
          where: { crewId, status: 'open' },
          data: { status: 'cancelled', resolvedAt: new Date() },
        });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        throw new ConflictException('Could not transfer ownership; please retry.');
      }
      throw e;
    }

    const memberIds = await this.prisma.crewMember
      .findMany({ where: { crewId }, select: { userId: true } })
      .then((rs) => rs.map((r) => r.userId));
    this.presenceRealtime.emitCrewOwnerChanged(memberIds, {
      crewId,
      newOwnerUserId,
      previousOwnerUserId,
      reason,
    });
    for (const userId of memberIds) {
      await this.notifications.create({
        recipientUserId: userId,
        kind: 'crew_owner_transferred',
        actorUserId: reason === 'inactivity' ? null : previousOwnerUserId,
        subjectCrewId: crewId,
      });
    }
  }
}
