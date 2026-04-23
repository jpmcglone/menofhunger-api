import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Crew, CrewMember, CrewMemberRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import {
  CREW_MEMBER_CAP,
  toCrewPrivateDto,
  toCrewPublicDto,
  type CrewPrivateDto,
  type CrewPublicDto,
} from '../../common/dto/crew.dto';
import { ensureUniqueCrewSlug, slugifyBase } from './crew.utils';

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_LIST_SELECT }>;
type MemberRow = CrewMember & { user: UserRow };
type CrewWithRelations = Crew & {
  owner: UserRow;
  members: MemberRow[];
};

@Injectable()
export class CrewService {
  private readonly logger = new Logger(CrewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------- assertions ----------

  /**
   * Crews require a real verified man. Premium alone is not sufficient (we want fidelity
   * to the "trusted community for men" mission). Throws 403 with a friendly message when
   * the user is unverified.
   */
  async assertVerified(userId: string): Promise<void> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { verifiedStatus: true, bannedAt: true },
    });
    if (!u) throw new NotFoundException('User not found.');
    if (u.bannedAt) throw new ForbiddenException('Account is suspended.');
    if (!u.verifiedStatus || u.verifiedStatus === 'none') {
      throw new ForbiddenException('Verify to use Crews.');
    }
  }

  async assertCrewMember(crewId: string, userId: string): Promise<MemberRow> {
    const mem = await this.prisma.crewMember.findUnique({
      where: { crewId_userId: { crewId, userId } },
      include: { user: { select: USER_LIST_SELECT } },
    });
    if (!mem) throw new ForbiddenException('You are not a member of this crew.');
    return mem as MemberRow;
  }

  async assertCrewOwner(crewId: string, userId: string): Promise<void> {
    const mem = await this.assertCrewMember(crewId, userId);
    if (mem.role !== 'owner') {
      throw new ForbiddenException('Only the crew owner can do that.');
    }
  }

  // ---------- fetching ----------

  async getMyCrewOrNull(viewerUserId: string): Promise<CrewPrivateDto | null> {
    const mem = await this.prisma.crewMember.findUnique({
      where: { userId: viewerUserId },
      select: { crewId: true, role: true },
    });
    if (!mem) return null;
    const crew = await this.loadCrewWithRelations(mem.crewId);
    if (!crew || crew.deletedAt) return null;
    return this.toMyCrewDto(crew, viewerUserId, mem.role);
  }

  async getCrewBySlug(params: {
    slug: string;
    viewerUserId: string | null;
  }): Promise<{
    crew: CrewPublicDto;
    redirectedFromSlug: string | null;
    /**
     * Viewer-specific membership info, populated only when the viewer is an
     * active member of the resolved crew. Lets the public page render
     * member-only surfaces (the chat button + unread badge, owner controls,
     * etc.) without an extra round-trip to /crew/me.
     */
    viewerMembership: {
      role: CrewMemberRole;
      wallConversationId: string;
      designatedSuccessorUserId: string | null;
      /**
       * Unread message count for the crew chat (the wall conversation), so the
       * page can render a badge on the "Chat" button without polling
       * /messages/unread-count separately.
       */
      unreadChatCount: number;
    } | null;
  }> {
    const s = (params.slug ?? '').trim().toLowerCase();
    if (!s) throw new NotFoundException('Crew not found.');

    const active = await this.prisma.crew.findFirst({
      where: { slug: s, deletedAt: null },
      include: {
        owner: { select: USER_LIST_SELECT },
        members: { include: { user: { select: USER_LIST_SELECT } } },
      },
    });
    if (active) {
      return {
        crew: this.toPublicDto(active as CrewWithRelations),
        redirectedFromSlug: null,
        viewerMembership: await this.computeViewerMembership(
          active as CrewWithRelations,
          params.viewerUserId,
        ),
      };
    }

    // Fall back to slug history for a 301-style redirect hint.
    const history = await this.prisma.crewSlugHistory.findUnique({ where: { slug: s } });
    if (!history) throw new NotFoundException('Crew not found.');

    const target = await this.prisma.crew.findFirst({
      where: { id: history.crewId, deletedAt: null },
      include: {
        owner: { select: USER_LIST_SELECT },
        members: { include: { user: { select: USER_LIST_SELECT } } },
      },
    });
    if (!target) throw new NotFoundException('Crew not found.');
    return {
      crew: this.toPublicDto(target as CrewWithRelations),
      redirectedFromSlug: s,
      viewerMembership: await this.computeViewerMembership(
        target as CrewWithRelations,
        params.viewerUserId,
      ),
    };
  }

  private async computeViewerMembership(
    crew: CrewWithRelations,
    viewerUserId: string | null,
  ): Promise<{
    role: CrewMemberRole;
    wallConversationId: string;
    designatedSuccessorUserId: string | null;
    unreadChatCount: number;
  } | null> {
    if (!viewerUserId) return null;
    const mem = crew.members.find((m) => m.userId === viewerUserId);
    if (!mem) return null;

    // Count messages on the chat conversation since the viewer's last read,
    // mirroring MessagesService.getUnreadCount (kept inline here to avoid a
    // CrewService → MessagesService dep just for one count).
    const participant = await this.prisma.messageParticipant.findUnique({
      where: {
        conversationId_userId: {
          conversationId: crew.wallConversationId,
          userId: viewerUserId,
        },
      },
      select: { lastReadAt: true },
    });
    const lastReadAt = participant?.lastReadAt ?? null;
    const unreadChatCount = await this.prisma.message.count({
      where: {
        conversationId: crew.wallConversationId,
        senderId: { not: viewerUserId },
        ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
      },
    });

    return {
      role: mem.role,
      wallConversationId: crew.wallConversationId,
      designatedSuccessorUserId: crew.designatedSuccessorUserId,
      unreadChatCount,
    };
  }

  async getPublicCrewForUser(userId: string): Promise<CrewPublicDto | null> {
    const mem = await this.prisma.crewMember.findUnique({
      where: { userId },
      select: { crewId: true },
    });
    if (!mem) return null;
    const crew = await this.loadCrewWithRelations(mem.crewId);
    if (!crew || crew.deletedAt) return null;
    return this.toPublicDto(crew);
  }

  // ---------- updates ----------

  async updateMyCrew(params: {
    viewerUserId: string;
    name?: string | null;
    tagline?: string | null;
    bio?: string | null;
    avatarImageUrl?: string | null;
    coverImageUrl?: string | null;
    designatedSuccessorUserId?: string | null;
  }): Promise<CrewPrivateDto> {
    await this.assertVerified(params.viewerUserId);
    const mem = await this.prisma.crewMember.findUnique({
      where: { userId: params.viewerUserId },
    });
    if (!mem) throw new NotFoundException('You are not in a crew.');
    await this.assertCrewOwner(mem.crewId, params.viewerUserId);

    const crew = await this.prisma.crew.findUniqueOrThrow({ where: { id: mem.crewId } });

    const data: Prisma.CrewUpdateInput = {};
    let slugRotation: { oldSlug: string; newSlug: string } | null = null;

    if (params.name !== undefined) {
      const next = (params.name ?? '').trim();
      const normalizedNext = next.length === 0 ? null : next;
      const prev = crew.name;
      data.name = normalizedNext;
      // If the name changed meaningfully, regen the slug (and record the old one).
      const prevSlugBase = slugifyBase(prev ?? 'crew');
      const nextSlugBase = slugifyBase(normalizedNext ?? 'crew');
      if (nextSlugBase !== prevSlugBase) {
        const nextSlug = await ensureUniqueCrewSlug(this.prisma, nextSlugBase, {
          excludeCrewId: crew.id,
        });
        if (nextSlug !== crew.slug) {
          slugRotation = { oldSlug: crew.slug, newSlug: nextSlug };
          data.slug = nextSlug;
        }
      }
    }
    if (params.tagline !== undefined) {
      const v = (params.tagline ?? '').trim();
      data.tagline = v.length === 0 ? null : v.slice(0, 160);
    }
    if (params.bio !== undefined) {
      const v = (params.bio ?? '').trim();
      data.bio = v.length === 0 ? null : v;
    }
    if (params.avatarImageUrl !== undefined) {
      const v = (params.avatarImageUrl ?? '').trim();
      data.avatarImageUrl = v.length === 0 ? null : v;
    }
    if (params.coverImageUrl !== undefined) {
      const v = (params.coverImageUrl ?? '').trim();
      data.coverImageUrl = v.length === 0 ? null : v;
    }
    if (params.designatedSuccessorUserId !== undefined) {
      const nextSuccessor = (params.designatedSuccessorUserId ?? '').trim();
      if (!nextSuccessor) {
        data.designatedSuccessor = { disconnect: true };
      } else {
        const target = await this.prisma.crewMember.findUnique({
          where: { crewId_userId: { crewId: crew.id, userId: nextSuccessor } },
          select: { userId: true, role: true },
        });
        if (!target || target.role === 'owner') {
          throw new BadRequestException('Designated successor must be a non-owner crew member.');
        }
        data.designatedSuccessor = { connect: { id: nextSuccessor } };
      }
    }

    await this.prisma.$transaction(async (tx) => {
      if (slugRotation) {
        // Preserve the old slug so /c/:oldSlug can 301 to the new one.
        await tx.crewSlugHistory.create({
          data: { crewId: crew.id, slug: slugRotation.oldSlug },
        });
      }
      await tx.crew.update({ where: { id: crew.id }, data });
    });

    const updated = await this.loadCrewWithRelationsOrThrow(crew.id);
    const dto = this.toMyCrewDto(updated, params.viewerUserId, 'owner');
    const memberIds = updated.members.map((m) => m.userId);
    this.presenceRealtime.emitCrewUpdated(memberIds, { crew: dto });
    return dto;
  }

  async leaveCrew(params: { viewerUserId: string }): Promise<void> {
    await this.assertVerified(params.viewerUserId);
    const mem = await this.prisma.crewMember.findUnique({
      where: { userId: params.viewerUserId },
    });
    if (!mem) return;
    if (mem.role === 'owner') {
      throw new BadRequestException(
        'Transfer ownership before leaving, or disband the crew.',
      );
    }
    const crewId = mem.crewId;
    await this.prisma.$transaction(async (tx) => {
      await tx.crewMember.delete({
        where: { crewId_userId: { crewId, userId: params.viewerUserId } },
      });
      await tx.crew.update({
        where: { id: crewId },
        data: {
          memberCount: { decrement: 1 },
          // Clear successor if the leaving user was designated.
          ...(mem.role === 'member'
            ? {
                designatedSuccessor: {
                  disconnect: true,
                } satisfies Prisma.UserUpdateOneWithoutCrewsDesignatedSuccessorOfNestedInput,
              }
            : {}),
        },
      });
      // Remove from wall conversation so they stop getting wall events.
      await tx.messageParticipant.deleteMany({
        where: { conversation: { crewWall: { id: crewId } }, userId: params.viewerUserId },
      });
    });
    const remaining = await this.prisma.crewMember.findMany({
      where: { crewId },
      select: { userId: true },
    });
    // Tidy stale "X joined your crew" / "X accepted your crew invite" rows from
    // other members' notifications — X is no longer a member, so those entries
    // are misleading. Best-effort; never block the leave flow if cleanup fails.
    await this.notifications
      .deleteCrewJoinedNotificationsForActor({ crewId, actorUserId: params.viewerUserId })
      .catch((err) => {
        this.logger.warn(`[crew] Failed to clean up join notifications on leave: ${err}`);
      });
    this.presenceRealtime.emitCrewMembersChanged(
      [...remaining.map((m) => m.userId), params.viewerUserId],
      { crewId, kind: 'left', userId: params.viewerUserId },
    );
  }

  async kickMember(params: {
    viewerUserId: string;
    crewId: string;
    userId: string;
  }): Promise<void> {
    await this.assertVerified(params.viewerUserId);
    if (params.userId === params.viewerUserId) {
      throw new BadRequestException('Use "leave" to remove yourself.');
    }
    await this.assertCrewOwner(params.crewId, params.viewerUserId);
    const target = await this.prisma.crewMember.findUnique({
      where: { crewId_userId: { crewId: params.crewId, userId: params.userId } },
    });
    if (!target) throw new NotFoundException('Member not found.');
    if (target.role === 'owner') throw new ForbiddenException('Cannot remove the owner.');

    await this.prisma.$transaction(async (tx) => {
      await tx.crewMember.delete({
        where: { crewId_userId: { crewId: params.crewId, userId: params.userId } },
      });
      await tx.crew.update({
        where: { id: params.crewId },
        data: {
          memberCount: { decrement: 1 },
          designatedSuccessor: { disconnect: true },
        },
      });
      await tx.messageParticipant.deleteMany({
        where: {
          conversation: { crewWall: { id: params.crewId } },
          userId: params.userId,
        },
      });
    });
    const remaining = await this.prisma.crewMember.findMany({
      where: { crewId: params.crewId },
      select: { userId: true },
    });
    await this.notifications
      .deleteCrewJoinedNotificationsForActor({
        crewId: params.crewId,
        actorUserId: params.userId,
      })
      .catch((err) => {
        this.logger.warn(`[crew] Failed to clean up join notifications on kick: ${err}`);
      });
    this.presenceRealtime.emitCrewMembersChanged(
      [...remaining.map((m) => m.userId), params.userId],
      { crewId: params.crewId, kind: 'kicked', userId: params.userId },
    );
  }

  /**
   * Tx-safe disband primitive: marks the crew deleted, removes all `CrewMember`
   * rows, and cancels any pending invites for the crew. Caller is responsible
   * for the surrounding transaction and for emitting realtime events after
   * commit (so events don't fire on rollback).
   *
   * Shared by `disbandCrew`, `adminForceDisband`, and the auto-disband path
   * in `CrewInvitesService.acceptInvite` when a solo crew member accepts an
   * invite to another crew.
   */
  async disbandCrewTx(tx: Prisma.TransactionClient, crewId: string): Promise<void> {
    await tx.crew.update({ where: { id: crewId }, data: { deletedAt: new Date() } });
    await tx.crewMember.deleteMany({ where: { crewId } });
    await tx.crewInvite.updateMany({
      where: { crewId, status: 'pending' },
      data: { status: 'cancelled', respondedAt: new Date() },
    });
  }

  /** Admin-force disband; bypasses owner consent and verification checks. */
  async adminForceDisband(crewId: string): Promise<void> {
    const crew = await this.prisma.crew.findUnique({
      where: { id: crewId },
      select: { id: true, deletedAt: true },
    });
    if (!crew || crew.deletedAt) return;
    const allMembers = await this.prisma.crewMember.findMany({
      where: { crewId },
      select: { userId: true },
    });
    await this.prisma.$transaction((tx) => this.disbandCrewTx(tx, crewId));
    this.presenceRealtime.emitCrewDisbanded(
      allMembers.map((m) => m.userId),
      { crewId },
    );
  }

  async disbandCrew(params: { viewerUserId: string }): Promise<void> {
    await this.assertVerified(params.viewerUserId);
    const mem = await this.prisma.crewMember.findUnique({
      where: { userId: params.viewerUserId },
    });
    if (!mem) throw new NotFoundException('You are not in a crew.');
    if (mem.role !== 'owner') {
      throw new ForbiddenException('Only the crew owner can disband the crew.');
    }
    const crewId = mem.crewId;
    const allMembers = await this.prisma.crewMember.findMany({
      where: { crewId },
      select: { userId: true },
    });
    await this.prisma.$transaction((tx) => this.disbandCrewTx(tx, crewId));
    this.presenceRealtime.emitCrewDisbanded(
      allMembers.map((m) => m.userId),
      { crewId },
    );
  }

  // ---------- dto helpers ----------

  private async loadCrewWithRelations(crewId: string): Promise<CrewWithRelations | null> {
    const c = await this.prisma.crew.findUnique({
      where: { id: crewId },
      include: {
        owner: { select: USER_LIST_SELECT },
        members: { include: { user: { select: USER_LIST_SELECT } } },
      },
    });
    return (c as CrewWithRelations | null) ?? null;
  }

  private async loadCrewWithRelationsOrThrow(crewId: string): Promise<CrewWithRelations> {
    const c = await this.loadCrewWithRelations(crewId);
    if (!c) throw new NotFoundException('Crew not found.');
    return c;
  }

  private toPublicDto(crew: CrewWithRelations): CrewPublicDto {
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    return toCrewPublicDto({
      crew,
      ownerRow: crew.owner,
      memberRows: crew.members,
      publicBaseUrl,
    });
  }

  private async toMyCrewDto(
    crew: CrewWithRelations,
    viewerUserId: string,
    viewerRole: CrewMemberRole,
  ): Promise<CrewPrivateDto> {
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const pendingInviteCount = await this.prisma.crewInvite.count({
      where: { crewId: crew.id, status: 'pending' },
    });
    return toCrewPrivateDto({
      crew,
      ownerRow: crew.owner,
      memberRows: crew.members,
      publicBaseUrl,
      viewerRole,
      pendingInviteCount,
    });
  }

  /** Exported for invites service. */
  async toPrivateDtoForMember(crewId: string, viewerUserId: string): Promise<CrewPrivateDto> {
    const mem = await this.assertCrewMember(crewId, viewerUserId);
    const crew = await this.loadCrewWithRelationsOrThrow(crewId);
    return this.toMyCrewDto(crew, viewerUserId, mem.role);
  }

  // ---------- constants ----------

  memberCap(): number {
    return CREW_MEMBER_CAP;
  }
}
