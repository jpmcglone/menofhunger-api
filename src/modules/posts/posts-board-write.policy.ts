import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { AppConfigService } from "../app/app-config.service";
import { PostsMutationSupportService } from "./posts-mutation-support.service";
import type { CreatePostParams } from "./posts-mutation.types";

export type PostWriteKind = NonNullable<CreatePostParams["kind"]>;
type BoardParent = {
  kind: string;
  rootId: string | null;
  articleId: string | null;
  body: string;
  mentions: Array<{ userId: string }>;
};

/** Board-specific invariants apply to every write surface, including generic reply endpoints. */
@Injectable()
export class PostsBoardWritePolicy {
  constructor(
    private readonly appConfig: AppConfigService,
    @Inject(PostsMutationSupportService)
    private readonly support: Pick<
      PostsMutationSupportService,
      "parseMentionsFromBody"
    >,
  ) {}
  resolve(
    params: CreatePostParams,
    parentPost: BoardParent | null,
    marvRequesterId?: string,
  ) {
    const { userId, parentId, visibility: requestedVisibility } = params;
    const requestedCommunityGroupId =
      (params.communityGroupId ?? "").trim() || null;
    let kind: PostWriteKind = params.kind ?? "regular";
    // Every reply inside a Board thread is a Board comment, whichever client sent it.
    if (parentPost?.kind === "board") {
      kind = "board";
      if (marvRequesterId) {
        const explicit = this.support
          .parseMentionsFromBody(parentPost.body)
          .some(
            (name) =>
              name.toLowerCase() ===
              this.appConfig.marvBot().username.trim().toLowerCase(),
          );
        if (
          !explicit ||
          !parentPost.mentions.some((mention) => mention.userId === userId)
        ) {
          throw new ForbiddenException(
            "This Board item no longer mentions Marv.",
          );
        }
      }
    }
    if (
      parentPost?.kind === "board" &&
      !parentPost.rootId &&
      parentPost.articleId
    ) {
      throw new BadRequestException("Comment on the article instead.");
    }
    if (kind === "board") {
      if (requestedCommunityGroupId)
        throw new BadRequestException(
          "Board posts cannot be posted inside a community group.",
        );
      if (params.poll)
        throw new BadRequestException("Polls are not supported on the Board.");
      if (!parentId && !params.board?.title?.trim())
        throw new BadRequestException("Board posts need a title.");
      if (parentId && params.board)
        throw new BadRequestException(
          "Board comments cannot carry thread fields.",
        );
      if (requestedVisibility === "onlyMe")
        throw new BadRequestException("Board posts cannot be only-me.");
    }
    const boardOnly =
      kind === "board" &&
      (Boolean(parentId) || params.board?.showInFeed === false);

    return { kind, boardOnly };
  }
}
