import { ForbiddenException } from '@nestjs/common';
import type { Response } from 'express';
import { setReadCache } from '../../common/http-cache';
import { toPostDto } from './post.dto';
import type { CommunityGroupPreviewDto } from '../../common/dto/community-group.dto';
import type { PostsController } from './posts.controller';
import type { PostsService } from './posts.service';

export async function loadPermalinkRelatedPostsOn(host: PostsController, params: {
  viewerUserId: string | null;
  viewerHasAdmin: boolean;
  leaf: Awaited<ReturnType<PostsService['getById']>>;
  leafGated: boolean;
}): Promise<{
  chain: Array<Awaited<ReturnType<PostsService['getById']>>>;
  gatedChainIndices: Set<number>;
  byId: Map<string, Awaited<ReturnType<PostsService['getById']>>>;
  repostedPostRaw: Awaited<ReturnType<PostsService['getById']>> | null;
}> {
  const { viewerUserId, viewerHasAdmin, leaf, leafGated } = params;
  const leafParentId = (leaf as { parentId?: string | null }).parentId ?? null;
  const leafRepostedId = (leaf as { repostedPostId?: string | null }).repostedPostId ?? null;

  const ancestorIds = await host.posts.collectAncestorPostIds([leafParentId, leafRepostedId]);
  const fetched = ancestorIds.length
    ? await host.posts.getByIds({ viewerUserId, ids: ancestorIds })
    : [];

  const byId = new Map<string, Awaited<ReturnType<PostsService['getById']>>>();
  for (const row of fetched) {
    const deletedAt = (row as { deletedAt?: Date | null }).deletedAt ?? null;
    if (deletedAt && !viewerHasAdmin) continue;
    byId.set(row.id, row);
  }

  const missingIds = ancestorIds.filter((id) => !byId.has(id));
  const gatedIds = new Set<string>();
  if (missingIds.length > 0) {
    const gatedRows = await Promise.all(
      missingIds.map((id) => host.posts.getByIdNoAccess(id).catch(() => null)),
    );
    for (const row of gatedRows) {
      if (!row) continue;
      byId.set(row.id, row);
      gatedIds.add(row.id);
    }
  }

  const chain: Array<Awaited<ReturnType<PostsService['getById']>>> = [leaf];
  const gatedChainIndices = new Set<number>();
  if (leafGated) gatedChainIndices.add(0);

  let current = leaf;
  while (current) {
    const parentId = (current as { parentId?: string | null }).parentId ?? null;
    if (!parentId) break;
    const next = byId.get(parentId);
    if (!next) break;
    chain.push(next);
    if (gatedIds.has(next.id)) {
      gatedChainIndices.add(chain.length - 1);
      break;
    }
    current = next;
  }

  const quotedSeeds = [
    ...chain,
    ...(leafRepostedId && byId.has(leafRepostedId) ? [byId.get(leafRepostedId)!] : []),
  ];
  const quotedPostIds = [
    ...new Set(
      quotedSeeds
        .map((p) => (p as { quotedPostId?: string | null }).quotedPostId)
        .filter((id): id is string => Boolean(id)),
    ),
  ].filter((id) => !byId.has(id));
  if (quotedPostIds.length > 0) {
    const quoted = await host.posts.getByIds({ viewerUserId, ids: quotedPostIds });
    for (const row of quoted) byId.set(row.id, row);
    const stillMissing = quotedPostIds.filter((id) => !byId.has(id));
    if (stillMissing.length > 0) {
      const gatedQuoted = await Promise.all(
        stillMissing.map((id) => host.posts.getByIdNoAccess(id).catch(() => null)),
      );
      for (const row of gatedQuoted) {
        if (row) byId.set(row.id, row);
      }
    }
  }

  return {
    chain,
    gatedChainIndices,
    byId,
    repostedPostRaw: leafRepostedId ? byId.get(leafRepostedId) ?? null : null,
  };
}


export async function getPostByIdOn(
  host: PostsController,
  userId: string | undefined,
  id: string,
  httpRes: Response,
) {
  const viewerUserId = userId ?? null;

  // Try to fetch the post with normal access rules; if forbidden (tier too low),
  // fall back to a stripped preview so /p/:id can still render the gated treatment.
  let viewerCanAccess = true;
  let post: Awaited<ReturnType<typeof host.posts.getById>>;
  try {
    post = await host.posts.getById({ viewerUserId, id });
  } catch (e) {
    if (e instanceof ForbiddenException) {
      post = await host.posts.getByIdNoAccess(id);
      viewerCanAccess = false;
    } else {
      throw e;
    }
  }

  const gatedGroupId =
    !viewerCanAccess && (post as { communityGroupId?: string | null }).communityGroupId
      ? String((post as { communityGroupId?: string | null }).communityGroupId)
      : null;
  const [viewer, groupPreview] = await Promise.all([
    host.posts.viewerContext(viewerUserId),
    gatedGroupId
      ? host.posts.communityGroupPreviewForGroup(gatedGroupId, viewerUserId)
      : Promise.resolve(null),
  ]);
  const viewerHasAdmin = Boolean(viewer?.siteAdmin);

  const { chain, gatedChainIndices, byId, repostedPostRaw } = await loadPermalinkRelatedPostsOn(host, {
    viewerUserId,
    viewerHasAdmin,
    leaf: post,
    leafGated: !viewerCanAccess,
  });

  // Build groupPreview map for any group post in the chain (including reposted) so the
  // permalink page can show the group context (back-strip, inline pill, nav highlight)
  // even when the viewer can access the post. Mirrors feed-list behavior.
  const allChainPostsForGroups: Awaited<ReturnType<typeof host.posts.getById>>[] = [
    ...chain,
    ...(repostedPostRaw ? [repostedPostRaw] : []),
  ];
  const groupIdsForPreview = Array.from(
    new Set(
      allChainPostsForGroups
        .map((p) => String((p as { communityGroupId?: string | null }).communityGroupId ?? '').trim())
        .filter((gid): gid is string => Boolean(gid)),
    ),
  );
  const allPosts = [...chain, ...(repostedPostRaw ? [repostedPostRaw] : [])];
  const postIds = allPosts.map((p) => p.id);

  // Quoted posts were batched with the ancestor chain (getByIds + gated fallback).
  const quotedPostIds = Array.from(
    new Set(
      allPosts
        .map((p) => (p as { quotedPostId?: string | null }).quotedPostId)
        .filter((qid): qid is string => Boolean(qid)),
    ),
  );
  const quotedPostByIdPermalink = new Map<string, Awaited<ReturnType<typeof host.posts.getById>>>();
  for (const qid of quotedPostIds) {
    const qp = byId.get(qid);
    if (qp) quotedPostByIdPermalink.set(qid, qp);
  }
  const [
    groupPreviewById,
    boosted,
    bookmarksByPostId,
    votedPollOptionIdByPostId,
    repostedByPostId,
    lastSeenAtByPostId,
    internalByPostId,
    scoreByPostIdGet,
    commentedByPostId,
  ] = await Promise.all([
    groupIdsForPreview.length
      ? host.communityGroupPreviewMapForIds(viewerUserId, groupIdsForPreview)
      : Promise.resolve(new Map<string, CommunityGroupPreviewDto>()),
    viewerUserId
      ? host.posts.viewerBoostedPostIds({ viewerUserId, postIds })
      : Promise.resolve(new Set<string>()),
    viewerUserId
      ? host.posts.viewerBookmarksByPostId({ viewerUserId, postIds })
      : Promise.resolve(new Map<string, { collectionIds: string[] }>()),
    viewerUserId
      ? host.posts.viewerVotedPollOptionIdByPostId({ viewerUserId, postIds })
      : Promise.resolve(new Map<string, string>()),
    viewerUserId
      ? host.posts.viewerRepostedPostIds({ viewerUserId, postIds })
      : Promise.resolve(new Set<string>()),
    viewerUserId
      ? host.posts.viewerLastSeenAtByPostId({ viewerUserId, postIds })
      : Promise.resolve(new Map<string, Date>()),
    viewerHasAdmin ? host.posts.ensureBoostScoresFresh(postIds) : Promise.resolve(null),
    viewerHasAdmin ? host.posts.computeScoresForPostIds(postIds) : Promise.resolve(undefined),
    viewerUserId
      ? host.posts.viewerCommentedPostIds({ viewerUserId, postIds })
      : Promise.resolve(new Set<string>()),
  ]);
  const viewedByPostId = new Set(lastSeenAtByPostId.keys());
  const videoEmbedByPostId = await host.posts.videoEmbedsForPosts([
    ...allPosts,
    ...quotedPostByIdPermalink.values(),
  ]);

  const r2 = host.appConfig.r2()?.publicBaseUrl ?? null;
  const toDto = (
    p: (typeof chain)[number],
    opts: {
      parent?: ReturnType<typeof toPostDto>;
      repostedPost?: ReturnType<typeof toPostDto>;
      isGatedRoot?: boolean;
      groupPreview?: Awaited<ReturnType<PostsService['communityGroupPreviewForGroup']>>;
    },
  ) => {
    const base = internalByPostId?.get(p.id);
    const score = scoreByPostIdGet?.get(p.id);
    const pWithPoll = p as { user?: { id?: string }; poll?: { creatorSkippedAt?: Date | null } };
    const viewerCreatorSkipped =
      Boolean(viewerUserId) &&
      pWithPoll.user?.id === viewerUserId &&
      Boolean(pWithPoll.poll?.creatorSkippedAt);
    // Prefer the gated-root preview (existing behavior) but fall back to per-post
    // group preview so accessible group posts also surface their group context.
    const ownGroupId = String((p as { communityGroupId?: string | null }).communityGroupId ?? '').trim();
    const ownGroupPreview = ownGroupId ? groupPreviewById.get(ownGroupId) ?? null : null;
    const resolvedGroupPreview = opts.isGatedRoot
      ? opts.groupPreview ?? null
      : ownGroupPreview ?? undefined;
    const quotedPostIdVal = (p as any).quotedPostId as string | null | undefined;
    const quotedPostFromMap = quotedPostIdVal ? quotedPostByIdPermalink.get(quotedPostIdVal) : undefined;
    const quotedPostDto = quotedPostFromMap
      ? toPostDto(quotedPostFromMap as any, r2, {
          videoEmbed: videoEmbedByPostId.get(quotedPostFromMap.id) ?? null,
        })
      : undefined;
    const dto = toPostDto(p, r2, {
      viewerHasBoosted: boosted.has(p.id),
      viewerHasBookmarked: bookmarksByPostId.has(p.id),
      viewerBookmarkCollectionIds: bookmarksByPostId.get(p.id)?.collectionIds ?? [],
      viewerVotedPollOptionId: votedPollOptionIdByPostId.get(p.id) ?? null,
      viewerHasReposted: repostedByPostId.has(p.id),
      viewerHasCommented: commentedByPostId.has(p.id),
      viewerHasViewed: viewedByPostId.has(p.id),
      viewerLastSeenAt: lastSeenAtByPostId.get(p.id)?.toISOString(),
      viewerCreatorSkipped: viewerCreatorSkipped || undefined,
      internalOverride:
        base || (typeof score === 'number' ? { score } : undefined)
          ? { ...base, ...(typeof score === 'number' ? { score } : {}) }
          : undefined,
      repostedPost: opts.repostedPost,
      quotedPost: quotedPostDto,
      // Only the root (requested) post is gated; ancestors are accessible.
      viewerCanAccess: opts.isGatedRoot ? false : undefined,
      groupPreview: resolvedGroupPreview,
      videoEmbed: videoEmbedByPostId.get(p.id) ?? null,
    });
    return opts.parent ? { ...dto, parent: opts.parent } : dto;
  };

  // Build reposted post DTO first (if this is a flat repost).
  const repostedPostDto = repostedPostRaw ? toDto(repostedPostRaw as any, {}) : undefined;

  // Build from root down: chain[chain.length-1] is root, chain[0] is leaf (the post we're viewing).
  // A chain entry is gated when either (a) the leaf was inaccessible (!viewerCanAccess && i===0)
  // or (b) an ancestor was fetched via getByIdNoAccess because the viewer's tier was too low.
  const rootIdx = chain.length - 1;
  let dto = toDto(chain[rootIdx], {
    repostedPost: repostedPostDto,
    isGatedRoot: gatedChainIndices.has(rootIdx),
    groupPreview: gatedChainIndices.has(rootIdx) ? groupPreview ?? undefined : undefined,
  });
  for (let i = chain.length - 2; i >= 0; i--) {
    const isGated = (!viewerCanAccess && i === 0) || gatedChainIndices.has(i);
    dto = toDto(chain[i], { parent: dto, isGatedRoot: isGated, groupPreview: isGated ? groupPreview ?? undefined : undefined });
  }
  // Single-post case (no parent): the chain has only one entry, already built above.
  if (!viewerCanAccess && chain.length === 1) {
    // Rebuild with gated flag
    dto = toDto(chain[0], { repostedPost: repostedPostDto, isGatedRoot: true, groupPreview });
  }

  setReadCache(httpRes, { viewerUserId });
  return { data: dto };
}
