import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { ViewerContextService } from './viewer-context.service';
import { POST_WITH_POLL_INCLUDE } from '../../common/prisma-includes/post.include';
import { buildAttachParentChain } from '../posts/posts.utils';
import { toPostDto, type PostDto } from '../../common/dto/post.dto';
import { toCommunityGroupPreviewDto, type CommunityGroupPreviewDto } from '../../common/dto/community-group.dto';

export type VisiblePost = Prisma.PostGetPayload<{ include: typeof POST_WITH_POLL_INCLUDE }>;

/**
 * Viewer-scoped post read access + DTO composition, shared by surfaces that
 * need to hydrate posts outside the main feed pipeline (notifications feed,
 * notification rows with embedded posts, etc.).
 *
 * Centralizes the visibility rules (allowed visibilities per viewer tier,
 * onlyMe restricted to self/admin) and the viewer overlay joins (boosts,
 * bookmarks, poll votes, reposts, blocks) needed to build a full PostDto.
 */
@Injectable()
export class PostVisibilityReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly viewerContextService: ViewerContextService,
  ) {}

  /** Fetch posts by id and filter to those the viewer is allowed to see, preserving input order. */
  async getVisiblePostsByIds(params: {
    viewerUserId: string;
    ids: string[];
    includeDeleted?: boolean;
    excludeBannedAuthors?: boolean;
  }): Promise<VisiblePost[]> {
    const { viewerUserId, ids, includeDeleted = false, excludeBannedAuthors = false } = params;
    const uniqueIds = [...new Set((ids ?? []).map((id) => (id ?? '').trim()).filter(Boolean))];
    if (!uniqueIds.length) return [];

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.viewerContextService.allowedPostVisibilities(viewer);

    const fetched = await this.prisma.post.findMany({
      where: {
        id: { in: uniqueIds },
        ...(includeDeleted ? {} : { deletedAt: null }),
        ...(excludeBannedAuthors ? { user: { bannedAt: null } } : {}),
      },
      include: POST_WITH_POLL_INCLUDE,
    });

    const visibleFetched = fetched.filter((post) => {
      const isSelf = Boolean(viewer && viewer.id === post.userId);
      if (isSelf) return true;
      if (post.visibility === 'onlyMe') return Boolean(viewer?.siteAdmin);
      return allowed.includes(post.visibility);
    });

    const byId = new Map(visibleFetched.map((p) => [p.id, p] as const));
    return uniqueIds.map((id) => byId.get(id)).filter((p): p is (typeof visibleFetched)[number] => Boolean(p));
  }

  /** Walk parent chains upward (batched) collecting every visible ancestor post. */
  async collectParentMapForViewer(
    viewerUserId: string,
    seedParentIds: Array<string | null | undefined>,
  ): Promise<Map<string, VisiblePost>> {
    const parentMap = new Map<string, VisiblePost>();
    let toFetch = new Set<string>((seedParentIds ?? []).filter((id): id is string => Boolean(id)));
    while (toFetch.size > 0) {
      const batch = [...toFetch].filter((id) => !parentMap.has(id));
      if (batch.length === 0) break;
      const rows = await this.getVisiblePostsByIds({
        viewerUserId,
        ids: batch,
        includeDeleted: true,
        excludeBannedAuthors: false,
      });
      const byId = new Map(rows.map((p) => [p.id, p] as const));
      const next = new Set<string>();
      for (const id of batch) {
        const post = byId.get(id);
        if (!post) continue;
        parentMap.set(id, post);
        if (post.parentId) next.add(post.parentId);
      }
      toFetch = next;
    }
    return parentMap;
  }

  /** Resolve reposted originals (visible to the viewer) keyed by post id. */
  async collectRepostedMapForViewer(
    viewerUserId: string,
    repostedPostIds: string[],
  ): Promise<Map<string, VisiblePost>> {
    const ids = [...new Set((repostedPostIds ?? []).map((id) => (id ?? '').trim()).filter(Boolean))];
    if (!ids.length) return new Map<string, VisiblePost>();
    const rows = await this.getVisiblePostsByIds({
      viewerUserId,
      ids,
      includeDeleted: true,
      excludeBannedAuthors: false,
    });
    return new Map(rows.map((p) => [p.id, p] as const));
  }

  /** Compose full PostDtos (with parent chains + viewer overlays) for an arbitrary post list. */
  async composePostDtoMapForViewer(
    viewerUserId: string,
    posts: VisiblePost[],
  ): Promise<Map<string, PostDto>> {
    if (!posts.length) return new Map();

    const repostedPostIds = posts
      .filter((p) => (p as { kind?: string; repostedPostId?: string | null }).kind === 'repost' && (p as { repostedPostId?: string | null }).repostedPostId)
      .map((p) => (p as { repostedPostId?: string | null }).repostedPostId as string);
    const [viewer, parentMap, repostedPostMap] = await Promise.all([
      this.viewerContextService.getViewer(viewerUserId),
      this.collectParentMapForViewer(viewerUserId, posts.map((p) => p.parentId)),
      this.collectRepostedMapForViewer(viewerUserId, repostedPostIds),
    ]);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);
    const allPostIds = [...posts.map((p) => p.id), ...parentMap.keys()];

    const [
      boostedRows,
      bookmarksRows,
      votedRows,
      repostedRows,
      blockSets,
    ] = await Promise.all([
      this.prisma.boost.findMany({
        where: { userId: viewerUserId, postId: { in: allPostIds } },
        select: { postId: true },
      }),
      this.prisma.bookmark.findMany({
        where: { userId: viewerUserId, postId: { in: allPostIds } },
        select: { postId: true, collections: { select: { collectionId: true } } },
      }).catch((e: unknown) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2021') return [];
        throw e;
      }),
      this.prisma.postPollVote.findMany({
        where: { userId: viewerUserId, poll: { postId: { in: allPostIds } } },
        select: { optionId: true, poll: { select: { postId: true } } },
      }),
      (this.prisma.post as any).findMany({
        where: { userId: viewerUserId, kind: 'repost', repostedPostId: { in: allPostIds }, deletedAt: null },
        select: { repostedPostId: true },
      }) as Promise<Array<{ repostedPostId: string | null }>>,
      this.prisma.userBlock.findMany({
        where: { OR: [{ blockerId: viewerUserId }, { blockedId: viewerUserId }] },
        select: { blockerId: true, blockedId: true },
      }),
    ]);

    const boosted = new Set(boostedRows.map((r) => r.postId));
    const bookmarksByPostId = new Map<string, { collectionIds: string[] }>();
    for (const row of bookmarksRows) {
      bookmarksByPostId.set(row.postId, { collectionIds: (row.collections ?? []).map((c) => c.collectionId) });
    }
    const votedPollOptionIdByPostId = new Map<string, string>();
    for (const row of votedRows) votedPollOptionIdByPostId.set(row.poll.postId, row.optionId);
    const repostedByPostId = new Set(
      repostedRows
        .map((r) => (r.repostedPostId ?? '').trim())
        .filter(Boolean),
    );
    const blockedByViewer = new Set<string>();
    const viewerBlockedBy = new Set<string>();
    for (const row of blockSets) {
      if (row.blockerId === viewerUserId) blockedByViewer.add(row.blockedId);
      if (row.blockedId === viewerUserId) viewerBlockedBy.add(row.blockerId);
    }

    const baseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    const groupIds = new Set<string>();
    const collectGroupId = (row: { communityGroupId?: string | null } | null | undefined) => {
      const g = String(row?.communityGroupId ?? '').trim();
      if (g) groupIds.add(g);
    };
    for (const p of posts) collectGroupId(p as { communityGroupId?: string | null });
    for (const p of parentMap.values()) collectGroupId(p as { communityGroupId?: string | null });
    for (const p of repostedPostMap.values()) collectGroupId(p as { communityGroupId?: string | null });
    const groupPreviewByGroupId = new Map<string, CommunityGroupPreviewDto>();
    if (groupIds.size > 0) {
      const ids = [...groupIds];
      const [groups, memberships] = await Promise.all([
        this.prisma.communityGroup.findMany({
          where: { id: { in: ids }, deletedAt: null },
        }),
        this.prisma.communityGroupMember.findMany({
          where: { groupId: { in: ids }, userId: viewerUserId },
          select: { groupId: true, status: true, role: true },
        }),
      ]);
      const memberByGroup = new Map(memberships.map((m) => [m.groupId, m] as const));
      for (const g of groups) {
        const dto = toCommunityGroupPreviewDto(g, memberByGroup.get(g.id) ?? null);
        if (dto) groupPreviewByGroupId.set(g.id, dto);
      }
    }

    const attachParentChain = buildAttachParentChain({
      parentMap,
      baseUrl,
      boosted,
      bookmarksByPostId,
      votedPollOptionIdByPostId,
      viewerUserId,
      viewerHasAdmin,
      internalByPostId: null,
      scoreByPostId: undefined,
      toPostDto,
      blockedByViewer,
      viewerBlockedBy,
      repostedByPostId,
      repostedPostMap: repostedPostMap as any,
      groupPreviewByGroupId,
    });

    return new Map(posts.map((p) => [p.id, attachParentChain(p)] as const));
  }
}
