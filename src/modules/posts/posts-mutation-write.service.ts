import { Inject, Injectable } from "@nestjs/common";
import { assertXCrosspostInput } from "../../common/crosspost/x-crosspost-input";
import { inferTopicsFromText } from "../../common/topics/topic-utils";
import { boardMarvReplyId } from "../marvin/services/board-marv-reply-id";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { PostsMutationSupportService } from "./posts-mutation-support.service";
import { PostsWriteAfterCommitService } from "./posts-write-after-commit.service";
import { PostsWriteAuthorizationService } from "./posts-write-authorization.service";
import { PostsWritePersistenceService } from "./posts-write-persistence.service";
import {
  cleanMutationMediaAndPoll,
  mutationUploadPrefixes,
} from "./posts-mutation-media";
import { excludeMarvUserId } from "./posts-mentions.helpers";
import type { CreatePostParams } from "./posts-mutation.types";

/** Publication orchestration: authorize, prepare, atomically persist, then notify after commit. */
@Injectable()
export class PostsMutationWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    @Inject(PostsMutationSupportService)
    private readonly support: Pick<
      PostsMutationSupportService,
      | "parseMentionsFromBody"
      | "resolveMentionUsernamesMap"
      | "parseHashtagsFromBody"
      | "parseCashtagsFromBody"
      | "postLinksCreate"
    >,
    private readonly authorization: PostsWriteAuthorizationService,
    private readonly persistence: PostsWritePersistenceService,
    private readonly afterCommit: PostsWriteAfterCommitService,
  ) {}
  async createPost(params: CreatePostParams) {
    // Old scheduled selections still publish locally; the X worker rechecks the latest content.
    if (!params.scheduledSource && params.crosspost?.x)
      assertXCrosspostInput(params, this.appConfig.integrationBudget().enabled);
    return this.writePost(params);
  }

  /** Internal reply path: only the configured bot, inside the requesting author's thread. */
  async createMarvReply(params: {
    botUserId: string;
    requestingUserId: string;
    parentId: string;
    body: string;
  }) {
    await this.authorization.assertMarvAuthor(params.botUserId);
    return this.writePost(
      {
        userId: params.botUserId,
        body: params.body,
        parentId: params.parentId,
        visibility: "public",
        media: null,
        poll: null,
      },
      params.requestingUserId,
    );
  }

  private async writePost(params: CreatePostParams, marvRequesterId?: string) {
    const { userId, body, parentId, mentions: clientMentions } = params;
    const now = new Date();
    const authorized = await this.authorization.authorize(
      params,
      now,
      marvRequesterId,
    );
    const {
      kind,
      boardOnly,
      visibility,
      resolvedCommunityGroupId,
      threadParticipantIds,
      parentAuthorUserId,
      threadRootId,
      parentTopics,
      rootTopics,
      rateLimitParams,
      checkinDayKey: checkinDayKeyRaw,
      checkinPrompt: checkinPromptRaw,
    } = authorized;
    const media = (params.media ?? []).filter(Boolean);
    const poll = params.poll;
    const {
      allowedImagePrefixes,
      allowedVideoPrefixes,
      allowedThumbnailPrefixes,
    } = mutationUploadPrefixes(userId);

    // Keys that exist in MediaContentHash (reused uploads from any user) are allowed.
    const pollImageKeys = (poll?.options ?? [])
      .map((o) => (o?.image?.r2Key ?? "").trim())
      .filter(Boolean);
    const uploadKeys = [
      ...media
        .filter((m) => m.source === "upload" && (m.r2Key ?? "").trim())
        .map((m) => (m.r2Key ?? "").trim()),
      ...pollImageKeys,
    ];

    // Pre-compute mention username sets so we can do the rate-limit count, media-hash
    // lookup and (single) mention resolution in one round trip.
    const fromBody = this.support.parseMentionsFromBody(body);
    const clientUsernames = Array.isArray(clientMentions)
      ? clientMentions.filter((x) => typeof x === "string" && x.length <= 120)
      : [];
    const allUsernames = [...new Set([...clientUsernames, ...fromBody])];

    const [recentPostCount, reusedKeyRows, mentionUsernameToId] =
      await Promise.all([
        rateLimitParams
          ? this.prisma.post.count({ where: rateLimitParams.where })
          : Promise.resolve(0),
        uploadKeys.length
          ? this.prisma.mediaContentHash.findMany({
              where: { r2Key: { in: uploadKeys } },
              select: { r2Key: true },
            })
          : Promise.resolve([] as Array<{ r2Key: string }>),
        // Single resolution covers both body mentions and thread-participant client mentions.
        this.support.resolveMentionUsernamesMap(allUsernames),
      ]);

    await this.authorization.assertRateLimit(rateLimitParams, recentPostCount);

    const { cleanedMedia, cleanedPollOptions } = cleanMutationMediaAndPoll({
      media,
      poll,
      reusedKeyRows,
      allowedImagePrefixes,
      allowedVideoPrefixes,
      allowedThumbnailPrefixes,
    });

    // Body-only mention ids used to be derived here for notification priority; that now happens
    // in PostsSideEffectsHandler, which re-parses the persisted body. Only the full resolved set
    // (for the PostMention rows) is still needed on the request path.
    const resolvedFromUsernames: string[] = [];
    {
      const seen = new Set<string>();
      const normAll = [
        ...new Set(
          allUsernames.map((u) => u.trim().slice(0, 120)).filter(Boolean),
        ),
      ];
      for (const name of normAll) {
        const id = mentionUsernameToId.get(name.toLowerCase());
        if (id && !seen.has(id)) {
          seen.add(id);
          resolvedFromUsernames.push(id);
        }
      }
    }

    // All mention IDs for PostMention records (include self so @yourname renders as a link).
    // Marv is not inherited from the thread — only an explicit @marv (in body or client list)
    // should create a mention row for him.
    const marvCfg = this.appConfig.marvBot();
    const marvId =
      marvCfg.userId ??
      mentionUsernameToId.get(marvCfg.username.trim().toLowerCase()) ??
      null;
    const mentionUserIds = [
      ...new Set([
        ...excludeMarvUserId(threadParticipantIds, marvId),
        ...resolvedFromUsernames,
      ]),
    ];

    const hashtagTokensRaw = this.support.parseHashtagsFromBody(body);
    const hashtagTokens = hashtagTokensRaw
      .map((t) => ({
        tag: (t.tag ?? "").trim().toLowerCase(),
        variant: (t.variant ?? "").trim(),
      }))
      .filter((t) => Boolean(t.tag && t.variant));
    hashtagTokens.sort(
      (a, b) =>
        a.tag.localeCompare(b.tag) || a.variant.localeCompare(b.variant),
    );
    const hashtags = hashtagTokens.map((t) => t.tag);
    const hashtagCasings = hashtagTokens.map((t) => t.variant);
    const cashtags = this.support.parseCashtagsFromBody(body);

    const relatedTopics = Array.from(
      new Set([...parentTopics, ...rootTopics]),
    ).filter(Boolean);
    const topics = inferTopicsFromText(body, { hashtags, relatedTopics });
    const result = await this.persistence.publish({
      data: {
        crosspostChoices: params.crosspost,
        ...(marvRequesterId && kind === "board" && parentId
          ? { id: boardMarvReplyId(parentId) }
          : {}),
        body,
        links: this.support.postLinksCreate(body),
        topics,
        hashtags,
        hashtagCasings,
        cashtags,
        visibility,
        userId,
        kind,
        ...(boardOnly ? { boardOnly: true } : {}),
        ...(kind === "board" && !parentId && params.board
          ? {
              boardThread: {
                create: {
                  title: params.board.title.trim(),
                  url: params.board.url,
                  urlNormalized: params.board.urlNormalized,
                  domain: params.board.domain,
                  tags: params.board.tags,
                  showInFeed: params.board.showInFeed,
                },
              },
              ...(params.articleId ? { articleId: params.articleId } : {}),
            }
          : {}),
        ...(resolvedCommunityGroupId
          ? { communityGroupId: resolvedCommunityGroupId }
          : {}),
        ...(kind === "checkin"
          ? {
              checkinDayKey: checkinDayKeyRaw ?? undefined,
              checkinPrompt: checkinPromptRaw ?? undefined,
            }
          : {}),
        parentId: parentId ?? undefined,
        rootId: threadRootId ?? undefined, // Set root post ID for thread hierarchy
        ...(cleanedMedia.length
          ? {
              media: {
                create: cleanedMedia,
              },
            }
          : {}),
        ...(mentionUserIds.length
          ? {
              // Nested-create mentions in the same query so the response includes them
              // and we don't need a post-transaction findUnique to fetch them.
              mentions: {
                create: mentionUserIds.map((uid) => ({ userId: uid })),
              },
            }
          : {}),
        ...(poll
          ? {
              poll: {
                create: {
                  endsAt: poll.endsAt,
                  ...(cleanedPollOptions?.length
                    ? {
                        options: {
                          create: cleanedPollOptions.map((o) => ({
                            text: o.text,
                            position: o.position,
                            imageR2Key: o.imageR2Key ?? undefined,
                            imageWidth: o.imageWidth ?? undefined,
                            imageHeight: o.imageHeight ?? undefined,
                            imageAlt: o.imageAlt ?? undefined,
                          })),
                        },
                      }
                    : {}),
                },
              },
            }
          : {}),
      },
      scheduledSource: params.scheduledSource,
      hashtagTokens,
      now,
      authorIsBot: authorized.authorIsBot,
    });
    const {
      post,
      parentCommentCount,
      boardRootToBump,
      boardRootCommentCount,
      didAwardStreak,
      quotedPostId,
      streakReward,
    } = result;
    this.afterCommit.run({
      post,
      userId,
      kind,
      visibility,
      parentId,
      parentCommentCount,
      parentAuthorUserId,
      parentIsBot: authorized.parentIsBot,
      boardRootToBump,
      boardRootCommentCount,
      quotedPostId,
      didAwardStreak,
      requestedMarvMode: params.marvMode ?? null,
      fromArticle: Boolean(params.articleId),
      hasMedia: (params.media?.length ?? 0) > 0,
      hasPoll: Boolean(params.poll),
      authorIsBot: authorized.authorIsBot,
      authorVerifiedStatus: authorized.authorVerifiedStatus,
    });

    return { post, streakReward };
  }
}
