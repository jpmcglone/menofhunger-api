import { socketData, payloadIdList, type GatewayViewer } from './gateway-socket-data';
import { isSiteAdminViewer } from '../../viewer/site-admin';
import { Injectable } from '@nestjs/common';
import { isPostVisibleToViewer } from '../../../common/posts/post-visibility';
import type { Socket } from 'socket.io';
import { PrismaService } from '../../prisma/prisma.service';
import { CommunityGroupReadAccessService } from '../../viewer/community-group-read-access.service';
import { WsEventNames, type ArticlesSubscribePayloadDto, type GroupsSubscribePayloadDto, type PostsSubscribePayloadDto } from '../../../common/dto';
import { MAX_ARTICLE_SUBSCRIPTIONS_PER_SOCKET, MAX_GROUP_SUBSCRIPTIONS_PER_SOCKET, MAX_POST_SUBSCRIPTIONS_PER_SOCKET, articleRoom, boardRoom, groupRoom, membersMapRoom, postRoom } from './gateway-rooms';
import { canSeeMembers } from '../../auth/auth-public-api';

import { PostsReadService } from '../../posts-read/posts-read.service';
import { NOT_DELETED } from '../../../common/prisma/where';
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
    private readonly postsRead: PostsReadService,
  ) {}

  async handlePostsSubscribe(client: Socket, payload: Partial<PostsSubscribePayloadDto>): Promise<void> {
    const raw = payloadIdList(payload, 'postIds');
    const requested = raw.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 200);
    if (requested.length === 0) return;

    const subs: Set<string> = socketData(client).postSubs ?? new Set<string>();
    socketData(client).postSubs = subs;
    const remainingCap = Math.max(0, MAX_POST_SUBSCRIPTIONS_PER_SOCKET - subs.size);
    if (remainingCap <= 0) return;

    const toConsider = Array.from(new Set(requested)).filter((id) => !subs.has(id)).slice(0, remainingCap);
    if (toConsider.length === 0) return;

    const viewerId = socketData(client).userId ?? null;
    const viewer: Partial<GatewayViewer> = socketData(client).viewer ?? {};
    const viewerIsAdmin = isSiteAdminViewer(viewer);
    const viewerIsVerified = viewerIsAdmin || Boolean(viewer?.verified);
    const viewerIsPremium = viewerIsAdmin || Boolean(viewer?.premium) || Boolean(viewer?.premiumPlus);

    const rows = await this.postsRead.findMany({
      where: { id: { in: toConsider }, ...NOT_DELETED },
      select: { id: true, userId: true, visibility: true, communityGroupId: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));

    // Batch-check group read access for any group-scoped posts.
    const groupIds = [...new Set(rows.map((r) => r.communityGroupId).filter(Boolean))] as string[];
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
      const vis = String(row.visibility ?? '');
      const gid: string | null = row.communityGroupId ?? null;
      const isSelf = Boolean(viewerId && row.userId === viewerId);

      // Tier gate (applies to all posts, including group posts).
      if (!isPostVisibleToViewer({ visibility: vis, isSelf, viewerIsVerified, viewerIsPremium })) continue;

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
    const raw = payloadIdList(payload, 'postIds');
    const ids = raw.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 200);
    if (ids.length === 0) return;
    const subs: Set<string> = socketData(client).postSubs ?? new Set<string>();
    for (const postId of ids) {
      subs.delete(postId);
      client.leave(postRoom(postId));
    }
    socketData(client).postSubs = subs;
  }

  async handleGroupsSubscribe(client: Socket, payload: Partial<GroupsSubscribePayloadDto>): Promise<void> {
    const raw = payloadIdList(payload, 'groupIds');
    const requested = raw.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 50);
    if (requested.length === 0) return;

    const subs: Set<string> = socketData(client).groupSubs ?? new Set<string>();
    socketData(client).groupSubs = subs;
    const remainingCap = Math.max(0, MAX_GROUP_SUBSCRIPTIONS_PER_SOCKET - subs.size);
    if (remainingCap <= 0) return;

    const toConsider = Array.from(new Set(requested)).filter((id) => !subs.has(id)).slice(0, remainingCap);
    if (toConsider.length === 0) return;

    const viewerId = socketData(client).userId ?? null;
    const viewer: Partial<GatewayViewer> = socketData(client).viewer ?? {};
    const viewerIsAdmin = isSiteAdminViewer(viewer);
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
    const raw = payloadIdList(payload, 'groupIds');
    const ids = raw.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 50);
    if (ids.length === 0) return;
    const subs: Set<string> = socketData(client).groupSubs ?? new Set<string>();
    for (const groupId of ids) {
      subs.delete(groupId);
      client.leave(groupRoom(groupId));
    }
    socketData(client).groupSubs = subs;
  }

  /** Board list: join the public room plus every tier room the viewer can read. */
  handleBoardSubscribe(client: Socket): void {
    const viewer: Partial<GatewayViewer> = socketData(client).viewer ?? {};
    const isAdmin = isSiteAdminViewer(viewer);
    client.join(boardRoom('public'));
    if (isAdmin || Boolean(viewer?.verified)) client.join(boardRoom('verified'));
    if (isAdmin || Boolean(viewer?.premium) || Boolean(viewer?.premiumPlus)) client.join(boardRoom('premium'));
  }

  handleBoardUnsubscribe(client: Socket): void {
    client.leave(boardRoom('public'));
    client.leave(boardRoom('verified'));
    client.leave(boardRoom('premium'));
  }

  /** Members map: verified viewers get the room with faces; everyone else only counts. */
  handleMembersMapSubscribe(client: Socket): void {
    const viewer: Partial<GatewayViewer> = socketData(client).viewer ?? {};
    client.join(membersMapRoom(canSeeMembers(viewer) ? 'members' : 'counts'));
  }

  handleMembersMapUnsubscribe(client: Socket): void {
    client.leave(membersMapRoom('members'));
    client.leave(membersMapRoom('counts'));
  }

  async handleArticlesSubscribe(client: Socket, payload: Partial<ArticlesSubscribePayloadDto>): Promise<void> {
    const raw = payloadIdList(payload, 'articleIds');
    const requested = raw.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 200);
    if (requested.length === 0) return;

    const subs: Set<string> = socketData(client).articleSubs ?? new Set<string>();
    socketData(client).articleSubs = subs;
    const remainingCap = Math.max(0, MAX_ARTICLE_SUBSCRIPTIONS_PER_SOCKET - subs.size);
    if (remainingCap <= 0) return;

    const toConsider = Array.from(new Set(requested)).filter((id) => !subs.has(id)).slice(0, remainingCap);
    if (toConsider.length === 0) return;

    const viewerId = socketData(client).userId ?? null;
    const viewer: Partial<GatewayViewer> = socketData(client).viewer ?? {};
    const viewerIsVerified = isSiteAdminViewer(viewer) || Boolean(viewer?.verified);
    const viewerIsPremium = isSiteAdminViewer(viewer) || Boolean(viewer?.premium) || Boolean(viewer?.premiumPlus);

    const rows = await this.prisma.article.findMany({
      where: { id: { in: toConsider }, ...NOT_DELETED },
      select: { id: true, authorId: true, visibility: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const accepted: string[] = [];

    for (const articleId of toConsider) {
      const row = byId.get(articleId);
      if (!row) continue;
      const vis = String(row.visibility ?? '');
      const isSelf = Boolean(viewerId && row.authorId === viewerId);
      if (!isPostVisibleToViewer({ visibility: vis, isSelf, viewerIsVerified, viewerIsPremium })) continue;

      subs.add(articleId);
      accepted.push(articleId);
      client.join(articleRoom(articleId));
    }

    if (accepted.length > 0) {
      client.emit(WsEventNames.articlesSubscribed, { articleIds: accepted });
    }
  }

  handleArticlesUnsubscribe(client: Socket, payload: Partial<ArticlesSubscribePayloadDto>): void {
    const raw = payloadIdList(payload, 'articleIds');
    const ids = raw.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 200);
    if (ids.length === 0) return;
    const subs: Set<string> = socketData(client).articleSubs ?? new Set<string>();
    for (const articleId of ids) {
      subs.delete(articleId);
      client.leave(articleRoom(articleId));
    }
    socketData(client).articleSubs = subs;
  }
}
