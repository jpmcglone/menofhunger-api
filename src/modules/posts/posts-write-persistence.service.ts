import { BadRequestException, Injectable } from "@nestjs/common";
import type { PostVisibility, Prisma } from "@prisma/client";
import {
  MENTION_USER_SELECT,
  USER_LIST_SELECT,
} from "../../common/prisma-selects/user.select";
import { BOARD_THREAD_PREVIEW_INCLUDE } from "../../common/prisma-includes/post.include";
import { NOT_DELETED } from "../../common/prisma/where";
import { LOGGED_IN_VIEW_WEIGHT } from "../views/view-tracking.utils";
import { PrismaService } from "../prisma/prisma.service";
import { PostsCheckinWriteService } from "./posts-checkin-write.service";
import { PostsQuoteWriteService } from "./posts-quote-write.service";
import type { PostWriteKind } from "./posts-board-write.policy";

/** Fields that the publication preparation phase is permitted to persist. */
type PostPublicationData = Pick<
  Prisma.PostUncheckedCreateInput,
  | "id"
  | "crosspostChoices"
  | "body"
  | "links"
  | "topics"
  | "hashtags"
  | "hashtagCasings"
  | "cashtags"
  | "visibility"
  | "userId"
  | "kind"
  | "boardOnly"
  | "boardThread"
  | "articleId"
  | "communityGroupId"
  | "checkinDayKey"
  | "checkinPrompt"
  | "parentId"
  | "rootId"
  | "media"
  | "mentions"
  | "poll"
> & {
  userId: string;
  body: string;
  kind: PostWriteKind;
  visibility: PostVisibility;
};
type PublishInput = {
  data: PostPublicationData;
  scheduledSource?: { id: string; revision: number };
  hashtagTokens: Array<{ tag: string; variant: string }>;
  authorIsBot: boolean;
  now: Date;
};

/** Owns the one atomic publication transaction; never emits or dispatches external effects. */
@Injectable()
export class PostsWritePersistenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quotes: PostsQuoteWriteService,
    private readonly checkins: PostsCheckinWriteService,
  ) {}

  async publish(input: PublishInput) {
    const { userId, body, kind, visibility, parentId } = input.data;
    const { now, hashtagTokens } = input;
    const boardRootToBump =
      kind === "board" &&
      parentId &&
      input.data.rootId &&
      input.data.rootId !== parentId
        ? input.data.rootId
        : null;
    const committed = await this.prisma
      .$transaction(async (tx) => {
        if (input.scheduledSource) {
          const claim = await tx.post.updateMany({
            where: {
              id: input.scheduledSource.id,
              userId,
              scheduledRevision: input.scheduledSource.revision,
              isDraft: true,
              ...NOT_DELETED,
              scheduledAt: { not: null, lte: now },
              scheduledPublishedPostId: null,
            },
            data: { deletedAt: now, scheduledAt: null },
          });
          if (!claim.count)
            throw new BadRequestException(
              "Scheduled post changed or was already published.",
            );
        }

        const quotedExists = await this.quotes.resolve(tx, {
          body,
          visibility,
          communityGroupId: input.data.communityGroupId ?? null,
        });
        const created = await tx.post.create({
          data: {
            ...input.data,
            ...(quotedExists ? { quotedPostId: quotedExists.id } : {}),
          },
          include: {
            user: { select: USER_LIST_SELECT },
            media: { orderBy: { position: "asc" } },
            mentions: { include: { user: { select: MENTION_USER_SELECT } } },
            poll: { include: { options: { orderBy: { position: "asc" } } } },
            boardThread: BOARD_THREAD_PREVIEW_INCLUDE,
          },
        });
        if (input.scheduledSource) {
          await tx.post.update({
            where: { id: input.scheduledSource.id },
            data: { scheduledPublishedPostId: created.id },
          });
        }

        const rewardOp =
          kind === "checkin" && visibility !== "onlyMe"
            ? this.checkins.award(tx, userId, now)
            : Promise.resolve(null);
        // Self-view seed: create the row then increment view counters (sequential by data dep).
        // Bots (e.g. Marv) do not count as viewers of their own posts.
        const selfViewOp = input.authorIsBot
          ? Promise.resolve()
          : (async () => {
              const seededView = await tx.postView.createMany({
                data: [{ postId: created.id, userId }],
                skipDuplicates: true,
              });
              if (seededView.count > 0) {
                const updatedCounts = await tx.post.update({
                  where: { id: created.id },
                  data: {
                    viewerCount: { increment: 1 },
                    totalViewCount: { increment: 1 },
                    weightedViewCount: { increment: LOGGED_IN_VIEW_WEIGHT },
                  },
                  select: {
                    viewerCount: true,
                    totalViewCount: true,
                    weightedViewCount: true,
                  },
                });
                created.viewerCount = updatedCounts.viewerCount;
                created.totalViewCount = updatedCounts.totalViewCount;
                created.weightedViewCount = updatedCounts.weightedViewCount;
              }
            })();

        // Parent commentCount increment (only when this is a reply).
        const parentBumpOp = parentId
          ? tx.post
              .update({
                where: { id: parentId },
                data: { commentCount: { increment: 1 } },
                select: { commentCount: true },
              })
              .then((parentAfter) => {
                return typeof parentAfter.commentCount === "number"
                  ? parentAfter.commentCount
                  : null;
              })
          : Promise.resolve(null);

        // Board threads count every comment on the root, so nested replies bump it too.
        const boardRootBumpOp = boardRootToBump
          ? tx.post
              .update({
                where: { id: boardRootToBump },
                data: { commentCount: { increment: 1 } },
                select: { commentCount: true },
              })
              .then((rootAfter) => {
                return rootAfter.commentCount;
              })
          : Promise.resolve(null);

        // Quoted-post repost + quoteCount counter bump (only when a local quote was detected).
        const quotedBumpOp = quotedExists
          ? this.quotes.record(tx, quotedExists.id)
          : Promise.resolve();

        // Hashtag upserts: each tag/variant pair is independent → fire all in parallel.
        const hashtagOps =
          hashtagTokens.length > 0
            ? Promise.all(
                hashtagTokens.flatMap((tok) => [
                  tx.hashtag.upsert({
                    where: { tag: tok.tag },
                    create: { tag: tok.tag, usageCount: 1 },
                    update: { usageCount: { increment: 1 } },
                  }),
                  tx.hashtagVariant.upsert({
                    where: {
                      tag_variant: { tag: tok.tag, variant: tok.variant },
                    },
                    create: { tag: tok.tag, variant: tok.variant, count: 1 },
                    update: { count: { increment: 1 } },
                  }),
                ]),
              )
            : Promise.resolve();

        // All post-create side effects fan out in parallel within the same transaction.
        const [parentCommentCount, boardRootCommentCount, , , streakReward] =
          await Promise.all([
            parentBumpOp,
            boardRootBumpOp,
            quotedBumpOp,
            hashtagOps,
            rewardOp,
            selfViewOp,
          ]);

        return {
          post: created,
          quotedPostId: quotedExists?.id ?? null,
          parentCommentCount,
          boardRootCommentCount,
          streakReward,
          didAwardStreak: streakReward !== null,
        };
      })
      .catch((error: unknown) => {
        if (kind === "checkin")
          this.checkins.rethrowPublicationError(error, now);
        throw error;
      });
    return { ...committed, boardRootToBump };
  }
}
