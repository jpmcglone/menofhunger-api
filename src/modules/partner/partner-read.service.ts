import { tiptapBodyToHtml } from '../pickax/pickax-content';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { PARTNER_POST_SELECT, PARTNER_PROFILE_SELECT } from './partner.constants';
import type { PartnerContentDto, PartnerProfileDto, PartnerVerificationDto } from './partner.dto';

import { PostsReadService } from '../posts-read/posts-read.service';
export type PartnerPageQuery = { cursor?: string; limit: number; q?: string };
export function decodePartnerCursor(cursor?: string): { id: string; createdAt: Date } | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (typeof parsed.id !== 'string' || parsed.id.length > 100 || !Number.isFinite(Date.parse(parsed.createdAt))) throw new Error();
    return { id: parsed.id, createdAt: new Date(parsed.createdAt) };
  } catch { throw new BadRequestException('Invalid pagination cursor.'); }
}
const after = (query: PartnerPageQuery) => {
  const cursor = decodePartnerCursor(query.cursor);
  return cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {};
};
const page = <T extends { id: string; createdAt: Date }>(rows: T[], limit: number, map: (r: T) => unknown) => {
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  return { data: selected.map(map), pagination: { nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ id: last.id, createdAt: last.createdAt.toISOString() })).toString('base64url') : null } };
};

@Injectable()
export class PartnerReadService {
  constructor(private readonly prisma: PrismaService, private readonly cfg: AppConfigService, private readonly postsRead: PostsReadService) {}
  private userWhere(viewer: string): Prisma.UserWhereInput {
    return { bannedAt: null, username: { not: null }, blocksInitiated: { none: { blockedId: viewer } }, blocksReceived: { none: { blockerId: viewer } } };
  }
  private postWhere(viewer: string): Prisma.PostWhereInput {
    return { deletedAt: null, isDraft: false, scheduledAt: null, visibility: 'public', communityGroupId: null,
      // Partner v1 does not expand quoted/reposted objects or Board/group shells.
      boardOnly: false, quotedPostId: null, repostedPostId: null,
      user: this.userWhere(viewer) };
  }
  private articleWhere(viewer: string): Prisma.ArticleWhereInput {
    return { deletedAt: null, isDraft: false, publishedAt: { not: null }, visibility: 'public', author: this.userWhere(viewer) };
  }
  profileDto(user: Prisma.UserGetPayload<{ select: typeof PARTNER_PROFILE_SELECT }>): PartnerProfileDto {
    return { id: user.id, username: user.username!, name: user.name, bio: user.bio, accountKind: user.accountKind,
      avatarUrl: publicAssetUrl({ publicBaseUrl: this.cfg.r2()?.publicBaseUrl ?? null, key: user.avatarKey }),
      canonicalUrl: `${this.cfg.frontendBaseUrl()}/u/${encodeURIComponent(user.username!)}`, createdAt: user.createdAt.toISOString() };
  }
  async profile(viewer: string, username: string, byId = false) {
    const user = await this.prisma.user.findFirst({ where: { AND: [this.userWhere(viewer), byId ? { id: username } : { username: { equals: username, mode: 'insensitive' } }] }, select: PARTNER_PROFILE_SELECT });
    if (!user) throw new NotFoundException();
    const [followers, following] = await Promise.all([
      this.prisma.follow.count({ where: { followingId: user.id, follower: this.userWhere(viewer) } }),
      this.prisma.follow.count({ where: { followerId: user.id, following: this.userWhere(viewer) } }),
    ]);
    return { ...this.profileDto(user), counts: { followers, following } };
  }
  async verification(userId: string): Promise<PartnerVerificationDto> {
    const u = await this.prisma.user.findFirst({ where: { id: userId, bannedAt: null }, select: { verifiedStatus: true, verifiedAt: true } });
    if (!u) throw new NotFoundException();
    return { accountId: userId, status: u.verifiedStatus, verifiedAt: u.verifiedAt?.toISOString() ?? null, checkedAt: new Date().toISOString() };
  }
  private postSelect(viewer: string) {
    return { ...PARTNER_POST_SELECT, _count: { select: {
      boosts: { where: { user: this.userWhere(viewer) } },
      replies: { where: this.postWhere(viewer) },
      views: { where: { user: this.userWhere(viewer) } },
    } } };
  }
  private postDto(row: Prisma.PostGetPayload<{ select: typeof PARTNER_POST_SELECT }> & { _count?: { boosts: number; replies: number; views: number } }): PartnerContentDto {
    return { id: row.id, kind: 'post', canonicalUrl: `${this.cfg.frontendBaseUrl()}/p/${row.id}`, status: 'published',
      source: { name: 'Men of Hunger', url: `${this.cfg.frontendBaseUrl()}/p/${row.id}` },
      ...(row._count ? { engagement: { boosts: row._count.boosts, comments: row._count.replies, uniqueViewers: row._count.views } } : {}),
      body: row.body, bodyFormat: 'text', publishedAt: row.createdAt.toISOString(), createdAt: row.createdAt.toISOString(), editedAt: row.editedAt?.toISOString() ?? null,
      author: this.profileDto(row.user), media: row.media.map(m => ({ kind: m.kind, alt: m.alt, width: m.width, height: m.height,
        url: m.r2Key ? publicAssetUrl({ publicBaseUrl: this.cfg.r2()?.publicBaseUrl ?? null, key: m.r2Key }) : m.url })) };
  }
  async post(viewer: string, id: string): Promise<PartnerContentDto> {
    // Check every ancestor; a public reply cannot expose a private root/thread.
    const seen = new Set<string>();
    let next: string | null = id;
    let result: PartnerContentDto | null = null;
    while (next) {
      if (seen.has(next) || seen.size >= 100) throw new NotFoundException();
      seen.add(next);
      const row: Prisma.PostGetPayload<{ select: typeof PARTNER_POST_SELECT }> | null = await this.postsRead.read.findFirst({ where: { AND: [this.postWhere(viewer), { id: next }] }, select: this.postSelect(viewer) });
      if (!row) throw new NotFoundException();
      if (row.articleId) await this.article(viewer, row.articleId);
      result ??= this.postDto(row);
      next = row.parentId;
    }
    if (!result) throw new NotFoundException();
    return result;
  }
  async article(viewer: string, id: string): Promise<PartnerContentDto> {
    const row = await this.prisma.article.findFirst({ where: { AND: [this.articleWhere(viewer), { id }] }, include: { author: { select: PARTNER_PROFILE_SELECT }, _count: { select: { boosts: { where: { user: this.userWhere(viewer) } }, comments: { where: this.commentWhere(viewer) }, views: { where: { user: this.userWhere(viewer) } }, reactions: { where: { user: this.userWhere(viewer) } } } } } });
    if (!row) throw new NotFoundException();
    return { id: row.id, kind: 'article', title: row.title, excerpt: row.excerpt, body: tiptapBodyToHtml(row.body), bodyFormat: 'html', publishedAt: row.publishedAt!.toISOString(),
      canonicalUrl: `${this.cfg.frontendBaseUrl()}/a/${row.id}`, status: 'published', createdAt: row.createdAt.toISOString(),
      source: { name: 'Men of Hunger', url: `${this.cfg.frontendBaseUrl()}/a/${row.id}` },
      engagement: { boosts: row._count.boosts, comments: row._count.comments, uniqueViewers: row._count.views, reactions: row._count.reactions },
      editedAt: row.editedAt?.toISOString() ?? null, author: this.profileDto(row.author), media: row.thumbnailR2Key ? [{ kind: 'image', url: publicAssetUrl({ publicBaseUrl: this.cfg.r2()?.publicBaseUrl ?? null, key: row.thumbnailR2Key }), alt: null, width: null, height: null }] : [] };
  }
  async posts(viewer: string, query: PartnerPageQuery, filter: { userId?: string; parentId?: string; articleId?: string } = {}) {
    if (filter.parentId) await this.post(viewer, filter.parentId);
    if (filter.articleId) await this.article(viewer, filter.articleId);
    const rows = await this.postsRead.read.findMany({ where: { AND: [this.postWhere(viewer), after(query), {
      ...filter, parentId: filter.parentId ?? null, ...(filter.parentId ? {} : { articleId: filter.articleId ?? null }),
      ...(query.q ? { body: { contains: query.q, mode: 'insensitive' } } : {}),
    }] }, select: this.postSelect(viewer), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1 });
    return page(rows, query.limit, row => this.postDto(row));
  }
  private commentWhere(viewer: string): Prisma.ArticleCommentWhereInput {
    return { deletedAt: null, author: this.userWhere(viewer), article: this.articleWhere(viewer),
      OR: [{ parentId: null }, { parent: { deletedAt: null, author: this.userWhere(viewer) } }] };
  }
  async articleComment(viewer: string, id: string) {
    const row = await this.prisma.articleComment.findFirst({ where: { AND: [this.commentWhere(viewer), { id }] }, include: { author: { select: PARTNER_PROFILE_SELECT } } });
    if (!row) throw new NotFoundException();
    return { id: row.id, articleId: row.articleId, parentId: row.parentId, body: row.body, bodyFormat: 'text',
      canonicalUrl: `${this.cfg.frontendBaseUrl()}/a/${row.articleId}#comment-${row.id}`, status: 'published',
      createdAt: row.createdAt.toISOString(), editedAt: row.editedAt?.toISOString() ?? null, author: this.profileDto(row.author) };
  }
  async articleComments(viewer: string, articleId: string, query: PartnerPageQuery) {
    await this.article(viewer, articleId);
    const rows = await this.prisma.articleComment.findMany({ where: { AND: [this.commentWhere(viewer), { articleId }, after(query)] },
      select: { id: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1 });
    const result = page(rows, query.limit, row => row);
    return { ...result, data: await Promise.all(rows.slice(0, query.limit).map(row => this.articleComment(viewer, row.id))) };
  }
  async articles(viewer: string, query: PartnerPageQuery, authorId?: string) {
    const rows = await this.prisma.article.findMany({ where: { AND: [this.articleWhere(viewer), after(query), {
      ...(authorId ? { authorId } : {}), ...(query.q ? { title: { contains: query.q, mode: 'insensitive' } } : {}),
    }] }, select: { id: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1 });
    const result = page(rows, query.limit, row => row);
    return { ...result, data: await Promise.all(rows.slice(0, query.limit).map(row => this.article(viewer, row.id))) };
  }
  async users(viewer: string, query: PartnerPageQuery) {
    const rows = await this.prisma.user.findMany({ where: { AND: [this.userWhere(viewer), after(query), { OR: [
      { username: { contains: query.q ?? '', mode: 'insensitive' } }, { name: { contains: query.q ?? '', mode: 'insensitive' } },
    ] }] }, select: PARTNER_PROFILE_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1 });
    return page(rows, query.limit, row => this.profileDto(row));
  }
  async social(userId: string, direction: 'followers' | 'following', query: PartnerPageQuery) {
    const follower = direction === 'following';
    const rows = await this.prisma.follow.findMany({ where: { AND: [after(query), follower ? { followerId: userId, following: this.userWhere(userId) } : { followingId: userId, follower: this.userWhere(userId) }] },
      include: { follower: { select: PARTNER_PROFILE_SELECT }, following: { select: PARTNER_PROFILE_SELECT } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1 });
    return page(rows, query.limit, row => this.profileDto(follower ? row.following : row.follower));
  }
}
