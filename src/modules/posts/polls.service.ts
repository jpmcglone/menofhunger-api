import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { VerifiedStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ViewerContextService } from '../viewer/viewer-context.service';

@Injectable()
export class PollsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly viewerContext: ViewerContextService,
  ) {}

  private allowedVisibilitiesForViewer(viewer: { verifiedStatus: VerifiedStatus; premium: boolean; premiumPlus?: boolean; siteAdmin?: boolean } | null) {
    return this.viewerContext.allowedPostVisibilities(viewer as any);
  }

  private async getPostForVoting(params: { viewerUserId: string; postId: string }) {
    const postId = (params.postId ?? '').trim();
    if (!postId) throw new NotFoundException('Post not found.');

    const viewer = await this.viewerContext.getViewer(params.viewerUserId ?? null);
    const allowed = this.allowedVisibilitiesForViewer(viewer);

    const post = await this.prisma.post.findFirst({
      where: { id: postId },
      select: { id: true, userId: true, deletedAt: true, visibility: true },
    });
    if (!post) throw new NotFoundException('Post not found.');

    // Author can always view their own posts.
    const isSelf = Boolean(viewer && viewer.id === post.userId);
    if (!isSelf) {
      // Only-me posts are private. Allow site admins to view for support/moderation.
      if (post.visibility === 'onlyMe' && !viewer?.siteAdmin) throw new ForbiddenException('This post is private.');
      if (!allowed.includes(post.visibility)) {
        if (post.visibility === 'verifiedOnly') throw new ForbiddenException('Verify to view verified-only posts.');
        if (post.visibility === 'premiumOnly') throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
        throw new ForbiddenException('Not allowed to view this post.');
      }
    }

    return post;
  }

  async voteOnPoll(params: { userId: string; postId: string; optionId: string }) {
    const { userId, postId, optionId } = params;
    const id = (postId ?? '').trim();
    const optId = (optionId ?? '').trim();
    if (!id) throw new NotFoundException('Post not found.');
    if (!optId) throw new BadRequestException('Invalid poll option.');

    const post = await this.getPostForVoting({ viewerUserId: userId, postId: id });
    if (post.deletedAt) throw new BadRequestException('Deleted posts cannot be voted on.');
    if (post.visibility === 'onlyMe') throw new BadRequestException('Only-me posts cannot be voted on.');
    if (post.userId === userId) throw new ForbiddenException('You cannot vote on your own poll.');

    const poll = await this.prisma.postPoll.findUnique({
      where: { postId: id },
      include: { options: { orderBy: { position: 'asc' } } },
    });
    if (!poll) throw new NotFoundException('Poll not found.');

    const now = new Date();
    if (poll.endsAt <= now) throw new BadRequestException('This poll has ended.');

    const opt = poll.options.find((o) => o.id === optId);
    if (!opt) throw new BadRequestException('Invalid poll option.');

    const updated = await this.prisma.$transaction(async (tx) => {
      try {
        await tx.postPollVote.create({
          data: {
            pollId: poll.id,
            optionId: optId,
            userId,
          },
        });
      } catch (err: any) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ForbiddenException('You have already voted on this poll.');
        }
        throw err;
      }

      await tx.postPollOption.update({ where: { id: optId }, data: { voteCount: { increment: 1 } } });
      return await tx.postPoll.update({
        where: { id: poll.id },
        data: { totalVoteCount: { increment: 1 } },
        include: { options: { orderBy: { position: 'asc' } } },
      });
    });

    return { poll: updated, viewerVotedOptionId: optId };
  }
}

