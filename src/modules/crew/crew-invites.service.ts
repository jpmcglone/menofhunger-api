import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import {
  CREW_INVITE_EXPIRY_DAYS,
  CREW_MEMBER_CAP,
  toCrewInviteDto,
  type CrewInviteDto,
} from '../../common/dto/crew.dto';
import { CrewService } from './crew.service';
import { ensureUniqueCrewSlug, slugifyBase } from './crew.utils';

const INVITE_INCLUDE = {
  crew: {
    include: {
      owner: { select: USER_LIST_SELECT },
      members: { include: { user: { select: USER_LIST_SELECT } } },
    },
  },
  invitedBy: { select: USER_LIST_SELECT },
  invitee: { select: USER_LIST_SELECT },
} satisfies Prisma.CrewInviteInclude;

type InviteWithRelations = Prisma.CrewInviteGetPayload<{ include: typeof INVITE_INCLUDE }>;

@Injectable()
export class CrewInvitesService {
  private readonly logger = new Logger(CrewInvitesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly notifications: NotificationsService,
    private readonly crew: CrewService,
  ) {}

  private expiryDate(): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + CREW_INVITE_EXPIRY_DAYS);
    return d;
  }

  private toDto(invite: InviteWithRelations): CrewInviteDto {
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    return toCrewInviteDto({ invite, publicBaseUrl });
  }

  // ---------- eligibility ----------

  /**
   * Solo crew members (their crew has exactly one member — themselves) are
   * treated as inviteable for the purposes of `sendInvite` and `acceptInvite`.
   * When such a user accepts an invite, their old 1-person crew is auto-disbanded
   * inside the accept transaction.
   *
   * Returns the user's *blocking* membership (i.e. their crew has > 1 member),
   * or `null` when the user has no membership OR is the sole member of a crew.
   */
  private async findBlockingMembership(
    userId: string,
  ): Promise<{ crewId: string; role: 'owner' | 'member' } | null> {
    const m = await this.prisma.crewMember.findUnique({
      where: { userId },
      select: { crewId: true, role: true, crew: { select: { memberCount: true } } },
    });
    if (!m) return null;
    if (m.crew.memberCount <= 1) return null;
    return { crewId: m.crewId, role: m.role };
  }

  /**
   * Returns the crew id when the user is the sole member of a non-deleted crew.
   * Used by `acceptInvite` to know which old crew to disband as part of joining
   * a new crew.
   */
  private async findSoloCrewIdToDisband(userId: string): Promise<string | null> {
    const m = await this.prisma.crewMember.findUnique({
      where: { userId },
      select: { crewId: true, crew: { select: { memberCount: true, deletedAt: true } } },
    });
    if (!m || !m.crew || m.crew.deletedAt) return null;
    if (m.crew.memberCount !== 1) return null;
    return m.crewId;
  }

  // ---------- read ----------

  async listInbox(params: { viewerUserId: string }): Promise<CrewInviteDto[]> {
    const rows = await this.prisma.crewInvite.findMany({
      where: { inviteeUserId: params.viewerUserId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      include: INVITE_INCLUDE,
    });
    return rows.map((r) => this.toDto(r));
  }

  async listOutbox(params: { viewerUserId: string }): Promise<CrewInviteDto[]> {
    const rows = await this.prisma.crewInvite.findMany({
      where: { invitedByUserId: params.viewerUserId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      include: INVITE_INCLUDE,
    });
    return rows.map((r) => this.toDto(r));
  }

  // ---------- write ----------

  async sendInvite(params: {
    viewerUserId: string;
    inviteeUserId: string;
    message?: string | null;
    /**
     * Founding invites only: name to seed the new crew with on acceptance. Ignored
     * for invites tied to an existing crew (use the standard crew rename path).
     */
    crewName?: string | null;
  }): Promise<CrewInviteDto> {
    await this.crew.assertVerified(params.viewerUserId);
    const inviteeId = (params.inviteeUserId ?? '').trim();
    if (!inviteeId) throw new BadRequestException('Invitee is required.');
    if (inviteeId === params.viewerUserId) {
      throw new BadRequestException('You cannot invite yourself.');
    }
    // Invitee must also be verified (crews require verified men only).
    const invitee = await this.prisma.user.findUnique({
      where: { id: inviteeId },
      select: { id: true, verifiedStatus: true, bannedAt: true },
    });
    if (!invitee || invitee.bannedAt) throw new NotFoundException('User not found.');
    if (!invitee.verifiedStatus || invitee.verifiedStatus === 'none') {
      throw new BadRequestException('You can only invite verified members to your crew.');
    }

    // Already in a crew with other people? They can't accept an invite. Solo
    // crew members (the only person in their crew) are still inviteable — when
    // they accept, their old crew is auto-disbanded as part of the join.
    const blocking = await this.findBlockingMembership(inviteeId);
    if (blocking) {
      throw new ConflictException('That member is already in a crew.');
    }

    const inviterMembership = await this.prisma.crewMember.findUnique({
      where: { userId: params.viewerUserId },
    });

    let crewId: string | null = null;
    if (inviterMembership) {
      if (inviterMembership.role !== 'owner') {
        throw new ForbiddenException('Only the crew owner can send invites.');
      }
      const crew = await this.prisma.crew.findUnique({
        where: { id: inviterMembership.crewId },
        select: { id: true, deletedAt: true, memberCount: true },
      });
      if (!crew || crew.deletedAt) throw new NotFoundException('Crew not found.');
      if (crew.memberCount >= CREW_MEMBER_CAP) {
        throw new ConflictException('Your crew is already at the member cap.');
      }
      const pending = await this.prisma.crewInvite.count({
        where: { crewId: crew.id, status: 'pending' },
      });
      if (crew.memberCount + pending >= CREW_MEMBER_CAP) {
        throw new ConflictException('Too many pending invites; cancel one before sending another.');
      }
      crewId = crew.id;
    }

    // Deduplicate: no more than one pending invite to the same invitee from the same inviter.
    const existing = await this.prisma.crewInvite.findFirst({
      where: {
        invitedByUserId: params.viewerUserId,
        inviteeUserId: inviteeId,
        status: 'pending',
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('You already have a pending invite for that person.');
    }

    // Only persist `crewNameOnAccept` for founding invites — for established crews
    // the canonical name lives on Crew.name and is changed via PATCH /crew/me.
    const foundingCrewName =
      crewId === null ? ((params.crewName ?? '').trim().slice(0, 80) || null) : null;

    const invite = await this.prisma.crewInvite.create({
      data: {
        crewId,
        invitedByUserId: params.viewerUserId,
        inviteeUserId: inviteeId,
        message: (params.message ?? '').trim().slice(0, 500) || null,
        crewNameOnAccept: foundingCrewName,
        expiresAt: this.expiryDate(),
      },
      include: INVITE_INCLUDE,
    });

    const dto = this.toDto(invite);

    // Notify + realtime.
    await this.notifications.create({
      recipientUserId: inviteeId,
      kind: 'crew_invite_received',
      actorUserId: params.viewerUserId,
      subjectCrewId: crewId,
      subjectCrewInviteId: invite.id,
      body: (params.message ?? '').trim().slice(0, 200) || null,
    });
    this.presenceRealtime.emitCrewInviteReceived(inviteeId, { invite: dto });

    return dto;
  }

  async cancelInvite(params: { viewerUserId: string; inviteId: string }): Promise<void> {
    await this.crew.assertVerified(params.viewerUserId);
    const invite = await this.prisma.crewInvite.findUnique({
      where: { id: params.inviteId },
    });
    if (!invite) throw new NotFoundException('Invite not found.');
    if (invite.status !== 'pending') {
      return; // Idempotent; already terminal.
    }
    if (invite.invitedByUserId !== params.viewerUserId) {
      throw new ForbiddenException('You can only cancel invites you sent.');
    }
    // For established crews, the owner is the only one allowed to invite, and only
    // the inviter can cancel; founding invites have no crew, so sender-only is enough.
    const updated = await this.prisma.crewInvite.update({
      where: { id: invite.id },
      data: { status: 'cancelled', respondedAt: new Date() },
      include: INVITE_INCLUDE,
    });
    const dto = this.toDto(updated);

    await this.notifications.create({
      recipientUserId: invite.inviteeUserId,
      kind: 'crew_invite_cancelled',
      actorUserId: params.viewerUserId,
      subjectCrewId: invite.crewId,
      subjectCrewInviteId: invite.id,
    });
    // Resolve the invitee's original "you've been invited" notification so the
    // bell badge clears for them — the invite is no longer actionable.
    await this.notifications.markCrewInviteResolved(invite.inviteeUserId, invite.id);
    this.presenceRealtime.emitCrewInviteUpdated(
      [invite.invitedByUserId, invite.inviteeUserId],
      { invite: dto },
    );
  }

  async declineInvite(params: { viewerUserId: string; inviteId: string }): Promise<void> {
    await this.crew.assertVerified(params.viewerUserId);
    const invite = await this.prisma.crewInvite.findUnique({
      where: { id: params.inviteId },
    });
    if (!invite) throw new NotFoundException('Invite not found.');
    if (invite.status !== 'pending') return;
    if (invite.inviteeUserId !== params.viewerUserId) {
      throw new ForbiddenException('You can only respond to invites sent to you.');
    }
    const updated = await this.prisma.crewInvite.update({
      where: { id: invite.id },
      data: { status: 'declined', respondedAt: new Date() },
      include: INVITE_INCLUDE,
    });
    const dto = this.toDto(updated);
    await this.notifications.create({
      recipientUserId: invite.invitedByUserId,
      kind: 'crew_invite_declined',
      actorUserId: params.viewerUserId,
      subjectCrewId: invite.crewId,
      subjectCrewInviteId: invite.id,
    });
    // Clear the invitee's original "you've been invited" notification.
    await this.notifications.markCrewInviteResolved(invite.inviteeUserId, invite.id);
    this.presenceRealtime.emitCrewInviteUpdated(
      [invite.invitedByUserId, invite.inviteeUserId],
      { invite: dto },
    );
  }

  async acceptInvite(params: { viewerUserId: string; inviteId: string }): Promise<{ crewId: string }> {
    await this.crew.assertVerified(params.viewerUserId);
    const invite = await this.prisma.crewInvite.findUnique({
      where: { id: params.inviteId },
    });
    if (!invite) throw new NotFoundException('Invite not found.');
    if (invite.status !== 'pending') {
      throw new BadRequestException('Invite is no longer pending.');
    }
    if (invite.inviteeUserId !== params.viewerUserId) {
      throw new ForbiddenException('You can only accept your own invites.');
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
      // Lazy-expire: flip and surface a clear error.
      await this.prisma.crewInvite.update({
        where: { id: invite.id },
        data: { status: 'expired', respondedAt: new Date() },
      });
      throw new BadRequestException('This invite has expired.');
    }

    // Invitee must not already be in a crew with other people. A solo crew
    // member (only one in their crew) is allowed to accept; their old crew
    // gets auto-disbanded inside the same transaction below.
    const blocking = await this.findBlockingMembership(params.viewerUserId);
    if (blocking) {
      throw new ConflictException('You are already in a crew.');
    }
    const soloCrewIdToDisband = await this.findSoloCrewIdToDisband(params.viewerUserId);

    // Founding invite: crew does not exist yet.
    // Branch 1: inviter already has a crew; joining that crew.
    // Branch 2: inviter is crewless; this is the FIRST acceptance, so the crew is created here.
    if (invite.crewId) {
      return this.acceptExistingCrewInvite({
        invite,
        viewerUserId: params.viewerUserId,
        soloCrewIdToDisband,
      });
    }
    return this.acceptFoundingInvite({
      invite,
      viewerUserId: params.viewerUserId,
      soloCrewIdToDisband,
    });
  }

  private async acceptExistingCrewInvite(params: {
    invite: Prisma.CrewInviteGetPayload<Record<string, never>>;
    viewerUserId: string;
    /**
     * If set, the viewer is the sole member of this crew today. We disband it
     * (set `deletedAt`, drop the `CrewMember` row, cancel pending invites)
     * inside the same accept transaction, with a race-safe guarded update so
     * the whole accept rolls back if a second member sneaks in concurrently.
     */
    soloCrewIdToDisband?: string | null;
  }): Promise<{ crewId: string }> {
    const { invite, viewerUserId, soloCrewIdToDisband } = params;
    const crewId = invite.crewId!;
    const crew = await this.prisma.crew.findUnique({
      where: { id: crewId },
      select: {
        id: true,
        deletedAt: true,
        memberCount: true,
        wallConversationId: true,
        ownerUserId: true,
      },
    });
    if (!crew || crew.deletedAt) {
      await this.prisma.crewInvite.update({
        where: { id: invite.id },
        data: { status: 'cancelled', respondedAt: new Date() },
      });
      throw new NotFoundException('Crew no longer exists.');
    }
    if (crew.memberCount >= CREW_MEMBER_CAP) {
      throw new ConflictException('Crew is already at the member cap.');
    }

    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        if (soloCrewIdToDisband) {
          // Race-safe: only disband if the crew really still has exactly one
          // member. If a second member joined since we checked above, this
          // update throws P2025 and the whole accept transaction rolls back.
          await tx.crew.update({
            where: { id: soloCrewIdToDisband, memberCount: 1 },
            data: { deletedAt: new Date() },
          });
          await this.crew.disbandCrewTx(tx, soloCrewIdToDisband);
        }
        await tx.crewMember.create({
          data: { crewId, userId: viewerUserId, role: 'member' },
        });
        await tx.crew.update({
          where: { id: crewId },
          data: { memberCount: { increment: 1 } },
        });
        await tx.crewInvite.update({
          where: { id: invite.id },
          data: { status: 'accepted', respondedAt: now },
        });
        // Add to the wall conversation so they receive real-time updates.
        await tx.messageParticipant.create({
          data: {
            conversationId: crew.wallConversationId,
            userId: viewerUserId,
            role: 'member',
            status: 'accepted',
            acceptedAt: now,
          },
        });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        // P2002: unique violation (CrewMember.userId race).
        // P2025: guarded update missed (e.g. solo crew gained a second member
        // between our pre-check and the tx).
        if (e.code === 'P2002' || e.code === 'P2025') {
          throw new ConflictException('You are already in a crew.');
        }
      }
      throw e;
    }

    if (soloCrewIdToDisband) {
      // The viewer was the only member of the disbanded crew, so emit only to
      // them. This nudges `useViewerCrew` to clear and any open `/c/oldslug`
      // page to redirect away.
      this.presenceRealtime.emitCrewDisbanded([viewerUserId], {
        crewId: soloCrewIdToDisband,
      });
    }

    const updatedInvite = await this.prisma.crewInvite.findUniqueOrThrow({
      where: { id: invite.id },
      include: INVITE_INCLUDE,
    });
    const inviteDto = this.toDto(updatedInvite);

    // Notify + realtime.
    await this.notifications.create({
      recipientUserId: invite.invitedByUserId,
      kind: 'crew_invite_accepted',
      actorUserId: viewerUserId,
      subjectCrewId: crewId,
      subjectCrewInviteId: invite.id,
    });
    const allMembers = await this.prisma.crewMember.findMany({
      where: { crewId },
      select: { userId: true },
    });
    // Notify every existing member that someone joined. Skip the inviter — they
    // already received `crew_invite_accepted` above; sending both for the same
    // event is redundant and trains people to ignore the row.
    for (const m of allMembers) {
      if (m.userId === viewerUserId) continue;
      if (m.userId === invite.invitedByUserId) continue;
      await this.notifications.create({
        recipientUserId: m.userId,
        kind: 'crew_member_joined',
        actorUserId: viewerUserId,
        subjectCrewId: crewId,
      });
    }

    // Clear the invitee's original "you've been invited" notification — they
    // just acted on it, so the bell badge should reflect that immediately.
    await this.notifications.markCrewInviteResolved(viewerUserId, invite.id);

    this.presenceRealtime.emitCrewInviteUpdated(
      [invite.invitedByUserId, invite.inviteeUserId],
      { invite: inviteDto },
    );
    this.presenceRealtime.emitCrewMembersChanged(
      allMembers.map((m) => m.userId),
      { crewId, kind: 'joined', userId: viewerUserId },
    );

    return { crewId };
  }

  private async acceptFoundingInvite(params: {
    invite: Prisma.CrewInviteGetPayload<Record<string, never>>;
    viewerUserId: string;
    /** See `acceptExistingCrewInvite.soloCrewIdToDisband`. */
    soloCrewIdToDisband?: string | null;
  }): Promise<{ crewId: string }> {
    const { invite, viewerUserId, soloCrewIdToDisband } = params;
    const inviterUserId = invite.invitedByUserId;

    // Ensure the inviter is still crewless — if they created/joined a crew in the meantime,
    // re-target the invite to the existing crew.
    const inviterMembership = await this.prisma.crewMember.findUnique({
      where: { userId: inviterUserId },
    });
    if (inviterMembership) {
      const newInvite = await this.prisma.crewInvite.update({
        where: { id: invite.id },
        data: { crewId: inviterMembership.crewId },
      });
      return this.acceptExistingCrewInvite({
        invite: newInvite,
        viewerUserId,
        soloCrewIdToDisband,
      });
    }

    // Create crew + owner membership + member membership + wall conversation atomically.
    // The inviter may have chosen a name when sending the founding invite; if so, use it
    // for both the crew name and the slug seed so /c/:slug is meaningful from the start.
    const now = new Date();
    const seedName = (invite.crewNameOnAccept ?? '').trim();
    const namedCrew = seedName.length > 0;
    const slug = await ensureUniqueCrewSlug(this.prisma, slugifyBase(namedCrew ? seedName : ''));
    let createdCrewId = '';
    try {
      createdCrewId = await this.prisma.$transaction(async (tx) => {
        if (soloCrewIdToDisband) {
          // Race-safe: only disband if still solo. P2025 here rolls back the
          // whole accept and surfaces "You are already in a crew."
          await tx.crew.update({
            where: { id: soloCrewIdToDisband, memberCount: 1 },
            data: { deletedAt: new Date() },
          });
          await this.crew.disbandCrewTx(tx, soloCrewIdToDisband);
        }
        // Wall conversation first (the Crew has a required non-null FK to it).
        const wall = await tx.messageConversation.create({
          data: {
            type: 'crew_wall',
            title: null,
            createdByUserId: inviterUserId,
          },
        });

        const crew = await tx.crew.create({
          data: {
            slug,
            name: namedCrew ? seedName : null,
            ownerUserId: inviterUserId,
            wallConversationId: wall.id,
            memberCount: 2,
          },
        });

        // Owner first, then invitee.
        await tx.crewMember.createMany({
          data: [
            { crewId: crew.id, userId: inviterUserId, role: 'owner' },
            { crewId: crew.id, userId: viewerUserId, role: 'member' },
          ],
        });
        // Wall participants mirror crew members.
        await tx.messageParticipant.createMany({
          data: [
            {
              conversationId: wall.id,
              userId: inviterUserId,
              role: 'owner',
              status: 'accepted',
              acceptedAt: now,
            },
            {
              conversationId: wall.id,
              userId: viewerUserId,
              role: 'member',
              status: 'accepted',
              acceptedAt: now,
            },
          ],
        });

        // Mark this invite accepted and retarget OTHER founding invites from the same inviter
        // to the newly-created crew so they can still be accepted.
        await tx.crewInvite.update({
          where: { id: invite.id },
          data: { status: 'accepted', respondedAt: now, crewId: crew.id },
        });
        await tx.crewInvite.updateMany({
          where: {
            invitedByUserId: inviterUserId,
            status: 'pending',
            crewId: null,
          },
          data: { crewId: crew.id },
        });

        return crew.id;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code === 'P2002') {
          // CrewMember.userId or Crew.slug unique violation — bubble as conflict.
          throw new ConflictException('Could not create crew; please retry.');
        }
        if (e.code === 'P2025') {
          // The guarded solo-disband update missed (someone joined the solo
          // crew concurrently). Treat as the existing-crew conflict.
          throw new ConflictException('You are already in a crew.');
        }
      }
      throw e;
    }

    if (soloCrewIdToDisband) {
      this.presenceRealtime.emitCrewDisbanded([viewerUserId], {
        crewId: soloCrewIdToDisband,
      });
    }

    // Notify + realtime.
    await this.notifications.create({
      recipientUserId: inviterUserId,
      kind: 'crew_invite_accepted',
      actorUserId: viewerUserId,
      subjectCrewId: createdCrewId,
      subjectCrewInviteId: invite.id,
    });

    const updatedInvite = await this.prisma.crewInvite.findUniqueOrThrow({
      where: { id: invite.id },
      include: INVITE_INCLUDE,
    });
    const inviteDto = this.toDto(updatedInvite);
    // Clear the invitee's original "you've been invited" notification.
    await this.notifications.markCrewInviteResolved(viewerUserId, invite.id);
    this.presenceRealtime.emitCrewInviteUpdated(
      [inviterUserId, viewerUserId],
      { invite: inviteDto },
    );
    this.presenceRealtime.emitCrewMembersChanged([inviterUserId, viewerUserId], {
      crewId: createdCrewId,
      kind: 'joined',
      userId: viewerUserId,
    });

    return { crewId: createdCrewId };
  }

  // ---------- expiry job ----------

  /**
   * Flip any pending invites past their expiry to `expired`. Called from the crew expiry cron.
   * Idempotent; returns the number of invites that were expired.
   */
  async expirePendingInvites(): Promise<number> {
    const now = new Date();
    const expiring = await this.prisma.crewInvite.findMany({
      where: { status: 'pending', expiresAt: { lte: now } },
      select: { id: true, invitedByUserId: true, inviteeUserId: true, crewId: true },
      take: 500,
    });
    if (expiring.length === 0) return 0;
    const ids = expiring.map((e) => e.id);
    const result = await this.prisma.crewInvite.updateMany({
      where: { id: { in: ids }, status: 'pending' },
      data: { status: 'expired', respondedAt: now },
    });
    for (const row of expiring) {
      // Clear the original received notification — the invite is no longer
      // actionable, so it shouldn't keep the bell badge bumped.
      await this.notifications.markCrewInviteResolved(row.inviteeUserId, row.id);
      this.presenceRealtime.emitCrewInviteUpdated(
        [row.invitedByUserId, row.inviteeUserId],
        { invite: { id: row.id, status: 'expired' } },
      );
    }
    return result.count;
  }
}
