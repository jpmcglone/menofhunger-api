import { Injectable } from '@nestjs/common';
import type { PostVisibility } from '@prisma/client';
import { POST_LIST_INCLUDE } from '../../common/prisma-includes/post.include';
import { assertPublishableText } from '../../common/moderation/content-filter';
import { PrismaService } from '../prisma/prisma.service';
import { PostsWriteAfterCommitService } from './posts-write-after-commit.service';

type ShareInput = { userId: string; body: string; visibility: PostVisibility };
type ShareRelation = { kind: 'articleShare'; articleId: string } | { kind: 'fitnessShare'; fitnessShareId: string };

/** Share surfaces authorize their source; posts owns the row shape and committed-post lifecycle. */
@Injectable()
export class PostsSharedWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly afterCommit: PostsWriteAfterCommitService,
  ) {}

  createArticleShare(input: ShareInput & { articleId: string }) {
    return this.createShare(input, { kind: 'articleShare', articleId: input.articleId });
  }

  createFitnessShare(input: ShareInput & { fitnessShareId: string }) {
    return this.createShare(input, { kind: 'fitnessShare', fitnessShareId: input.fitnessShareId });
  }

  private async createShare(input: ShareInput, relation: ShareRelation) {
    assertPublishableText(input.body);
    const post = await this.prisma.post.create({
      data: { userId: input.userId, body: input.body.trim(), visibility: input.visibility, ...relation },
      include: POST_LIST_INCLUDE,
    });
    this.afterCommit.run({
      post,
      userId: input.userId,
      kind: relation.kind,
      visibility: input.visibility,
      parentId: null,
      parentCommentCount: null,
      parentAuthorUserId: null,
      parentIsBot: undefined,
      boardRootToBump: null,
      boardRootCommentCount: null,
      quotedPostId: null,
      didAwardStreak: false,
      requestedMarvMode: null,
      fromArticle: relation.kind === 'articleShare',
      hasMedia: false,
      hasPoll: false,
      authorIsBot: Boolean(post.user.isBot),
      authorVerifiedStatus: post.user.verifiedStatus,
    });
    return post;
  }
}
