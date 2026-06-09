import { Injectable } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { PrismaService } from '../../prisma/prisma.service';
import { CommunityGroupReadAccessService } from '../../viewer/community-group-read-access.service';
import {
  WsEventNames,
  type ArticlesSubscribePayloadDto,
  type GroupsSubscribePayloadDto,
  type PostsSubscribePayloadDto,
} from '../../../common/dto';
import {
  MAX_ARTICLE_SUBSCRIPTIONS_PER_SOCKET,
  MAX_GROUP_SUBSCRIPTIONS_PER_SOCKET,
  MAX_POST_SUBSCRIPTIONS_PER_SOCKET,
  articleRoom,
  groupRoom,
  postRoom,
} from './gateway-rooms';

/**
 * Content room subscriptions: posts, groups, and articles. Each subscribe is
 * access-gated (visibility tier, group membership) so a socket can never sit
 * in a room it isn't allowed to read.
 */
@Injectable()
export class ContentSubscriptionsHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly groupReadAccess: CommunityGroupReadAccessService,
  ) {}

  async handlePostsSubscribe(client: Socket, payload: Partial<PostsSubscribePayloadDto>): Promise<void> {
    const raw = Array.isArray((payload as any)?.postIds) ? ((payload as any).postIds as unknown[]) : [];
    const requested = raw.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 200);
    if (requested.length === 0) return;

    const subs: Set<string> = (client.data as any).postSubs ?? new Set<string>();
    (client.data as any).postSubs = subs;
    const remainingCap = Math.max(0, MAX_POST_SUBSCRIPTIONS_PER_SOCKET - subs.size);
    if (remainingCap <= 0) return;

    const toConsider = Array.from(new Set(requested)).filter((id) => !subs.has(id)).slice(0, remainingCap);
    if (toConsider.length === 0) return;

    const viewerId = (client.data as { userId?: string })?.userId ?? null;
    const viewer = (client.data as any)?.viewer ?? {};
    const viewerIsAdmin = Boolean(viewer?.siteAdmin);
    const viewerIsVerified = viewerIsAdmin || Boolean(viewer?.verified);
    const viewerIsPremium = viewerIsAdmin || Boolean(viewer?.premium) || Boolean(viewer?.premiumPlus);

    const rows = await this.prisma.post.findMany({
      where: { id: { in: toConsider }, deletedAt: null },
      select: { id: true, userId: true, visibility: true, communityGroupId: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));

    // Batch-check group read access for any group-scoped posts.
    const groupIds = [...new Set(rows.map((r) => (r as any).communityGroupId).filter(Boolean))] as string[];
    const readableGroupIds = groupIds.length
      ? await this.groupReadAccess.filterReadableGroupIds({
          viewerUserId: viewerId,
          viewerIsAdmin,
          viewerIsVerified,
          groupIds,
        })
      : new Set<string>();

    const accepted: string[] = [];

    for (const postId of toConsider) {
      const row = byId.get(postId);
      if (!row) continue;
      const vis = String((row as any).visibility ?? '');
      const gid: string | null = (row as any).communityGroupId ?? null;
      const isSelf = Boolean(viewerId && row.userId === viewerId);

      // Tier gate (applies to all posts, including group posts).
      if (vis === 'onlyMe' && !isSelf) continue;
      if (vis === 'verifiedOnly' && !viewerIsVerified && !isSelf) continue;
      if (vis === 'premiumOnly' && !viewerIsPremium && !isSelf) continue;

      // Group membership gate (group posts require active membership or open-group access).
      if (gid && !isSelf && !readableGroupIds.has(gid)) continue;

      subs.add(postId);
      accepted.push(postId);
      client.join(postRoom(postId));
    }

    if (accepted.length > 0) {
      client.emit(WsEventNames.postsSubscribed, { postIds: accepted });
    }
  }

  handlePostsUnsubscribe(client: Socket, payload: Partial<PostsSubscribePayloadDto>): void {
    const raw = Array.isArray((payload as any)?.postIds) ? ((payload as any).postIds as unknown[]) : [];
    const ids = raw.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 200);
    if (ids.length === 0) return;
    const subs: Set<string> = (client.data as any).postSubs ?? new Set<string>();
    for (const postId of ids) {
      subs.delete(postId);
      client.leave(postRoom(postId));
    }
    (client.data as any).postSubs = subs;
  }

  async handleGroupsSubscribe(client: Socket, payload: Partial<GroupsSubscribePayloadDto>): Promise<void> {
    const raw = Array.isArray((payload as any)?.groupIds) ? ((payload as any).groupIds as unknown[]) : [];
    const requested = raw.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 50);
    if (requested.length === 0) return;

    const subs: Set<string> = (client.data as any).groupSubs ?? new Set<string>();
    (client.data as any).groupSubs = subs;
    const remainingCap = Math.max(0, MAX_GROUP_SUBSCRIPTIONS_PER_SOCKET - subs.size);
    if (remainingCap <= 0) return;

    const toConsider = Array.from(new Set(requested)).filter((id) => !subs.has(id)).slice(0, remainingCap);
    if (toConsider.length === 0) return;

    const viewerId = (client.data as { userId?: string })?.userId ?? null;
    const viewer = (client.data as any)?.viewer ?? {};
    const viewerIsAdmin = Boolean(viewer?.siteAdmin);
    const viewerIsVerified = viewerIsAdmin || Boolean(viewer?.verified);

    // Group feeds are private surfaces: a socket may only join a group's room if the
    // viewer can read that group's feed (active member, or an open group they're verified
    // for, or a site admin). Same predicate as the HTTP read path.
    const readableGroupIds = await this.groupReadAccess.filterReadableGroupIds({
      viewerUserId: viewerId,
      viewerIsAdmin,
      viewerIsVerified,
      groupIds: toConsider,
    });

    const accepted: string[] = [];
    for (const groupId of toConsider) {
      if (!readableGroupIds.has(groupId)) continue;
      subs.add(groupId);
      accepted.push(groupId);
      client.join(groupRoom(groupId));
    }

    if (accepted.length > 0) {
      client.emit(WsEventNames.groupsSubscribed, { groupIds: accepted });
    }
  }

  handleGroupsUnsubscribe(client: Socket, payload: Partial<GroupsSubscribePayloadDto>): void {
    const raw = Array.isArray((payload as any)?.groupIds) ? ((payload as any).groupIds as unknown[]) : [];
    const ids = raw.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 50);
    if (ids.length === 0) return;
    const subs: Set<string> = (client.data as any).groupSubs ?? new Set<string>();
    for (const groupId of ids) {
      subs.delete(groupId);
      client.leave(groupRoom(groupId));
    }
    (client.data as any).groupSubs = subs;
  }

  async handleArticlesSubscribe(client: Socket, payload: Partial<ArticlesSubscribePayloadDto>): Promise<void> {
    const raw = Array.isArray((payload as any)?.articleIds) ? ((payload as any).articleIds as unknown[]) : [];
    const requested = raw.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 200);
    if (requested.length === 0) return;

    const subs: Set<string> = (client.data as any).articleSubs ?? new Set<string>();
    (client.data as any).articleSubs = subs;
    const remainingCap = Math.max(0, MAX_ARTICLE_SUBSCRIPTIONS_PER_SOCKET - subs.size);
    if (remainingCap <= 0) return;

    const toConsider = Array.from(new Set(requested)).filter((id) => !subs.has(id)).slice(0, remainingCap);
    if (toConsider.length === 0) return;

    const viewerId = (client.data as { userId?: string })?.userId ?? null;
    const viewer = (client.data as any)?.viewer ?? {};
    const viewerIsVerified = Boolean(viewer?.siteAdmin) || Boolean(viewer?.verified);
    const viewerIsPremium = Boolean(viewer?.siteAdmin) || Boolean(viewer?.premium) || Boolean(viewer?.premiumPlus);

    const rows = await this.prisma.article.findMany({
      where: { id: { in: toConsider }, deletedAt: null },
      select: { id: true, authorId: true, visibility: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const accepted: string[] = [];

    for (const articleId of toConsider) {
      const row = byId.get(articleId);
      if (!row) continue;
      const vis = String((row as any).visibility ?? '');
      const isSelf = Boolean(viewerId && row.authorId === viewerId);
      if (vis === 'onlyMe' && !isSelf) continue;
      if (vis === 'verifiedOnly' && !viewerIsVerified && !isSelf) continue;
      if (vis === 'premiumOnly' && !viewerIsPremium && !isSelf) continue;

      subs.add(articleId);
      accepted.push(articleId);
      client.join(articleRoom(articleId));
    }

    if (accepted.length > 0) {
      client.emit(WsEventNames.articlesSubscribed, { articleIds: accepted });
    }
  }

  handleArticlesUnsubscribe(client: Socket, payload: Partial<ArticlesSubscribePayloadDto>): void {
    const raw = Array.isArray((payload as any)?.articleIds) ? ((payload as any).articleIds as unknown[]) : [];
    const ids = raw.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 200);
    if (ids.length === 0) return;
    const subs: Set<string> = (client.data as any).articleSubs ?? new Set<string>();
    for (const articleId of ids) {
      subs.delete(articleId);
      client.leave(articleRoom(articleId));
    }
    (client.data as any).articleSubs = subs;
  }
}
