import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { CurrentUserId, OptionalCurrentUserId } from '../users/users.decorator';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { type MessageMediaInput } from '../messages/messages.service';
import { CrewService } from './crew.service';
import { CrewInvitesService } from './crew-invites.service';
import { CrewWallService } from './crew-wall.service';
import { CrewTransferService } from './crew-transfer.service';

const updateCrewSchema = z.object({
  name: z.string().trim().max(80).nullish(),
  tagline: z.string().trim().max(160).nullish(),
  bio: z.string().trim().max(4000).nullish(),
  avatarImageUrl: z.string().trim().max(2000).nullish(),
  coverImageUrl: z.string().trim().max(2000).nullish(),
  designatedSuccessorUserId: z.string().trim().min(1).nullish(),
});

const inviteSchema = z.object({
  inviteeUserId: z.string().trim().min(1),
  message: z.string().trim().max(500).nullish(),
  /**
   * For founding invites only: name to use for the new crew when this invite is
   * accepted. Ignored for invites tied to an existing crew (rename via PATCH /crew/me).
   */
  crewName: z.string().trim().max(80).nullish(),
});

const messageMediaSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('upload'),
    kind: z.enum(['image', 'gif', 'video']),
    r2Key: z.string().min(1),
    thumbnailR2Key: z.string().optional().nullable(),
    width: z.coerce.number().int().positive().optional().nullable(),
    height: z.coerce.number().int().positive().optional().nullable(),
    durationSeconds: z.coerce.number().min(0).optional().nullable(),
    alt: z.string().max(500).optional().nullable(),
  }),
  z.object({
    source: z.literal('giphy'),
    kind: z.literal('gif'),
    url: z.string().url(),
    mp4Url: z.string().url().optional().nullable(),
    width: z.coerce.number().int().positive().optional().nullable(),
    height: z.coerce.number().int().positive().optional().nullable(),
    alt: z.string().max(500).optional().nullable(),
  }),
]);

const sendWallMessageSchema = z
  .object({
    body: z.string().trim().max(2000).optional(),
    media: z.array(messageMediaSchema).max(1).optional(),
  })
  .refine((v) => (v.body?.trim()?.length ?? 0) > 0 || (v.media?.length ?? 0) > 0, {
    message: 'Message must have a body or media.',
  });

const listWallSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

const transferSchema = z.object({
  newOwnerUserId: z.string().trim().min(1),
});

const openVoteSchema = z.object({
  targetUserId: z.string().trim().min(1),
});

const ballotSchema = z.object({
  inFavor: z.boolean(),
});

@Controller('crew')
export class CrewController {
  constructor(
    private readonly crew: CrewService,
    private readonly invites: CrewInvitesService,
    private readonly wall: CrewWallService,
    private readonly transfer: CrewTransferService,
  ) {}

  // ---------- my crew ----------

  @UseGuards(AuthGuard)
  @Throttle({
    default: { limit: rateLimitLimit('publicRead', 240), ttl: rateLimitTtl('publicRead', 60) },
  })
  @Get('me')
  async getMyCrew(@CurrentUserId() viewerUserId: string) {
    const crew = await this.crew.getMyCrewOrNull(viewerUserId);
    return { data: { crew } };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: { limit: rateLimitLimit('interact', 30), ttl: rateLimitTtl('interact', 60) },
  })
  @Patch('me')
  async updateMyCrew(@CurrentUserId() viewerUserId: string, @Body() body: unknown) {
    const parsed = updateCrewSchema.parse(body);
    const crew = await this.crew.updateMyCrew({
      viewerUserId,
      name: parsed.name ?? undefined,
      tagline: parsed.tagline ?? undefined,
      bio: parsed.bio ?? undefined,
      avatarImageUrl: parsed.avatarImageUrl ?? undefined,
      coverImageUrl: parsed.coverImageUrl ?? undefined,
      designatedSuccessorUserId: parsed.designatedSuccessorUserId ?? undefined,
    });
    return { data: { crew } };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: { limit: rateLimitLimit('interact', 10), ttl: rateLimitTtl('interact', 60) },
  })
  @Post('me/leave')
  async leave(@CurrentUserId() viewerUserId: string) {
    await this.crew.leaveCrew({ viewerUserId });
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: { limit: rateLimitLimit('interact', 5), ttl: rateLimitTtl('interact', 60) },
  })
  @Delete('me')
  async disband(@CurrentUserId() viewerUserId: string) {
    await this.crew.disbandCrew({ viewerUserId });
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Delete('me/members/:userId')
  async kick(
    @CurrentUserId() viewerUserId: string,
    @Param('userId') userId: string,
  ) {
    // Owner is always part of the viewer's crew; service loads the crewId.
    const mine = await this.crew.getMyCrewOrNull(viewerUserId);
    if (!mine) return { data: {} };
    await this.crew.kickMember({ viewerUserId, crewId: mine.id, userId });
    return { data: {} };
  }

  // ---------- invites ----------

  @UseGuards(AuthGuard)
  @Get('invites/inbox')
  async inbox(@CurrentUserId() viewerUserId: string) {
    const data = await this.invites.listInbox({ viewerUserId });
    return { data };
  }

  @UseGuards(AuthGuard)
  @Get('invites/outbox')
  async outbox(@CurrentUserId() viewerUserId: string) {
    const data = await this.invites.listOutbox({ viewerUserId });
    return { data };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: { limit: rateLimitLimit('interact', 30), ttl: rateLimitTtl('interact', 60) },
  })
  @Post('invites')
  async invite(@CurrentUserId() viewerUserId: string, @Body() body: unknown) {
    const parsed = inviteSchema.parse(body);
    const invite = await this.invites.sendInvite({
      viewerUserId,
      inviteeUserId: parsed.inviteeUserId,
      message: parsed.message ?? null,
      crewName: parsed.crewName ?? null,
    });
    return { data: { invite } };
  }

  @UseGuards(AuthGuard)
  @Post('invites/:id/accept')
  async acceptInvite(@CurrentUserId() viewerUserId: string, @Param('id') id: string) {
    const result = await this.invites.acceptInvite({ viewerUserId, inviteId: id });
    return { data: result };
  }

  @UseGuards(AuthGuard)
  @Post('invites/:id/decline')
  async declineInvite(@CurrentUserId() viewerUserId: string, @Param('id') id: string) {
    await this.invites.declineInvite({ viewerUserId, inviteId: id });
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Delete('invites/:id')
  async cancelInvite(@CurrentUserId() viewerUserId: string, @Param('id') id: string) {
    await this.invites.cancelInvite({ viewerUserId, inviteId: id });
    return { data: {} };
  }

  // ---------- wall ----------

  @UseGuards(AuthGuard)
  @Throttle({
    default: { limit: rateLimitLimit('publicRead', 240), ttl: rateLimitTtl('publicRead', 60) },
  })
  @Get('me/wall')
  async listWall(@CurrentUserId() viewerUserId: string, @Query() query: unknown) {
    const parsed = listWallSchema.parse(query);
    const result = await this.wall.getMyWall({
      viewerUserId,
      limit: parsed.limit ?? undefined,
      cursor: parsed.cursor ?? null,
    });
    return {
      data: {
        crewId: result.crewId,
        conversationId: result.conversationId,
        messages: result.messages,
      },
      pagination: { nextCursor: result.nextCursor },
    };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: { limit: rateLimitLimit('interact', 120), ttl: rateLimitTtl('interact', 60) },
  })
  @Post('me/wall')
  async postWall(@CurrentUserId() viewerUserId: string, @Body() body: unknown) {
    const parsed = sendWallMessageSchema.parse(body);
    const result = await this.wall.sendWallMessage({
      viewerUserId,
      body: parsed.body ?? '',
      replyToId: null,
      media: (parsed.media ?? []) as MessageMediaInput[],
    });
    return { data: result };
  }

  // ---------- ownership ----------

  @UseGuards(AuthGuard)
  @Post('me/transfer')
  async transferOwnership(
    @CurrentUserId() viewerUserId: string,
    @Body() body: unknown,
  ) {
    const parsed = transferSchema.parse(body);
    await this.transfer.directTransfer({
      viewerUserId,
      newOwnerUserId: parsed.newOwnerUserId,
    });
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Post('me/transfer-votes')
  async openTransferVote(
    @CurrentUserId() viewerUserId: string,
    @Body() body: unknown,
  ) {
    const parsed = openVoteSchema.parse(body);
    const vote = await this.transfer.openTransferVote({
      viewerUserId,
      targetUserId: parsed.targetUserId,
    });
    return { data: { voteId: vote.id, status: vote.status } };
  }

  @UseGuards(AuthGuard)
  @Post('me/transfer-votes/:id/ballot')
  async castBallot(
    @CurrentUserId() viewerUserId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = ballotSchema.parse(body);
    await this.transfer.castBallot({
      viewerUserId,
      voteId: id,
      inFavor: parsed.inFavor,
    });
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Delete('me/transfer-votes/:id')
  async cancelTransferVote(
    @CurrentUserId() viewerUserId: string,
    @Param('id') id: string,
  ) {
    await this.transfer.cancelTransferVote({ viewerUserId, voteId: id });
    return { data: {} };
  }

  // ---------- public ----------

  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: { limit: rateLimitLimit('publicRead', 240), ttl: rateLimitTtl('publicRead', 60) },
  })
  @Get('by-slug/:slug')
  async getBySlug(
    @OptionalCurrentUserId() viewerUserId: string | undefined,
    @Param('slug') slug: string,
  ) {
    const { crew, redirectedFromSlug, viewerMembership } = await this.crew.getCrewBySlug({
      slug,
      viewerUserId: viewerUserId ?? null,
    });
    return { data: { crew, redirectedFromSlug, viewerMembership } };
  }

  /** Compact crew summary for profile pills (null when the user is not in a crew). */
  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: { limit: rateLimitLimit('publicRead', 240), ttl: rateLimitTtl('publicRead', 60) },
  })
  @Get('for-user/:userId')
  async forUser(@Param('userId') userId: string) {
    const crew = await this.crew.getPublicCrewForUser(userId);
    return { data: { crew } };
  }
}
