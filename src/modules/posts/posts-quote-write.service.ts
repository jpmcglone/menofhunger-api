import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { PostVisibility, Prisma } from "@prisma/client";
import { NOT_DELETED } from "../../common/prisma/where";
import { PostsMutationSupportService } from "./posts-mutation-support.service";

/** Quote audience decisions and counter updates use the publication's transaction client. */
@Injectable()
export class PostsQuoteWriteService {
  constructor(
    @Inject(PostsMutationSupportService)
    private readonly support: Pick<
      PostsMutationSupportService,
      "extractQuotedPostIdFromBody" | "visibilityRank"
    >,
  ) {}

  async resolve(
    tx: Prisma.TransactionClient,
    input: {
      body: string;
      visibility: PostVisibility;
      communityGroupId: string | null;
    },
  ) {
    const { body, visibility, communityGroupId } = input;
    const detectedQuotedPostId = this.support.extractQuotedPostIdFromBody(body);
    const quotedExists = detectedQuotedPostId
      ? await tx.post.findFirst({
          where: { id: detectedQuotedPostId, ...NOT_DELETED },
          select: {
            id: true,
            userId: true,
            visibility: true,
            communityGroupId: true,
          },
        })
      : null;

    // Quote floor: the quoting post's effective visibility must not be more open than
    // the quoted post's visibility.  Applied universally — replies, group posts, and
    // check-ins are no longer bypassed.
    //
    // `visibility` is already the effective value: parentPost.visibility for replies,
    // 'verifiedOnly' for group posts, requestedVisibility otherwise.
    //
    // Exception: a group post quoting a post that lives in the same group is allowed
    // because every member of the group has read access regardless of their tier.
    if (quotedExists) {
      const sameGroup =
        communityGroupId && quotedExists.communityGroupId === communityGroupId;
      if (
        !sameGroup &&
        this.support.visibilityRank(visibility) <
          this.support.visibilityRank(quotedExists.visibility)
      ) {
        throw new ForbiddenException(
          "A quote can't be more public than the post it quotes.",
        );
      }
    }

    return quotedExists;
  }

  async record(tx: Prisma.TransactionClient, postId: string): Promise<void> {
    await tx.post.update({
      where: { id: postId },
      data: { repostCount: { increment: 1 }, quoteCount: { increment: 1 } },
    });
  }
}
