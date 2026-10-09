import { Injectable, NotFoundException } from '@nestjs/common';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { toAvatarVideoDto } from '../../common/dto/avatar-video.dto';
import type {
  LinksPageDto,
  LinksPageRecentItemDto,
  MyConnectedAccountDto,
  MyProfileLinkDto,
  MyProfileLinksDto,
} from '../../common/dto/profile-links.dto';
import { totalUserArticlesWhere, totalUserPostsWhere } from '../../common/content-counts';
import { profileLinkDisplay } from '../../common/urls/profile-link-url';
import { AppConfigService } from '../app/app-config.service';
import { PostsReadService } from '../posts-read/posts-read.service';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_PROFILE_LINKS, linkSettingsSchema, ProfileLinksWriteService } from '../users/profile-links-write.service';
import { ProfileLinksService, toProfileLinkDto, toPublicProfileLinkDtos } from '../users/profile-links.service';
import { XProfilePreviewService } from '../x/x-profile-preview.service';
import { XPublicSnapshotService } from '../x/x-public-snapshot.service';

const RECENT_LIMIT = 3;
const EXCERPT_MAX = 140;

const CONNECTION_SELECT = {
  xUsername: true,
  pickaxUsername: true,
  showXFollowerCount: true,
  xConnection: { select: { xUserId: true, username: true } },
  pickaxConnection: { select: { username: true } },
} as const;

type ConnectionSource = {
  xUsername: string | null;
  pickaxUsername: string | null;
  showXFollowerCount: boolean;
  xConnection: { xUserId: string; username: string } | null;
  pickaxConnection: { username: string } | null;
};

function cleanHandle(value: string | null | undefined): string | null {
  const handle = (value ?? '').trim().replace(/^@/, '');
  return handle || null;
}

/** Collapse whitespace and cut to the excerpt limit. */
export function plainExcerpt(text: string | null | undefined, max = EXCERPT_MAX): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Public links page and the owner's editor payload. The public path only reads Postgres. */
@Injectable()
export class LinksPageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly postsRead: PostsReadService,
    private readonly profileLinks: ProfileLinksService,
    private readonly linksWrite: ProfileLinksWriteService,
    private readonly xSnapshots: XPublicSnapshotService,
    private readonly xPreview: XProfilePreviewService,
  ) {}

  async getPage(rawUsername: string, viewerUserId: string | null): Promise<LinksPageDto> {
    const username = (rawUsername ?? '').trim().toLowerCase();
    if (!username) throw new NotFoundException('User not found.');

    const user = await this.prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
      select: {
        id: true,
        username: true,
        usernameIsSet: true,
        bannedAt: true,
        name: true,
        bio: true,
        locationDisplay: true,
        verifiedStatus: true,
        isOrganization: true,
        premium: true,
        premiumPlus: true,
        avatarKey: true,
        avatarUpdatedAt: true,
        avatarVideoKey: true,
        avatarVideoDurationMs: true,
        referralCode: true,
        ...CONNECTION_SELECT,
      },
    });
    if (!user || !user.usernameIsSet || !user.username || user.bannedAt) {
      throw new NotFoundException('User not found.');
    }
    if (viewerUserId) {
      const block = await this.prisma.userBlock.findFirst({
        where: {
          OR: [
            { blockerId: viewerUserId, blockedId: user.id },
            { blockerId: user.id, blockedId: viewerUserId },
          ],
        },
        select: { blockerId: true },
      });
      if (block) throw new NotFoundException('User not found.');
    }

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const [rows, connectedAccounts, recent] = await Promise.all([
      this.profileLinks.listRows(user.id),
      this.connectedAccounts(user, { readSnapshot: true }),
      this.recentItems(user.id),
    ]);

    return {
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        bio: user.bio,
        locationDisplay: user.locationDisplay,
        verifiedStatus: user.verifiedStatus,
        isOrganization: user.isOrganization,
        premium: user.premium,
        premiumPlus: user.premiumPlus,
        avatarUrl: publicAssetUrl({ publicBaseUrl, key: user.avatarKey, updatedAt: user.avatarUpdatedAt }),
        avatarVideo: toAvatarVideoDto(user, publicBaseUrl),
      },
      connectedAccounts: connectedAccounts.map(({ network, handle, url, followerCount }) => ({
        network,
        handle,
        url,
        followerCount,
      })),
      links: toPublicProfileLinkDtos(rows, user.verifiedStatus !== 'none'),
      recent,
      // Never mint a code on a public read.
      referralCode: user.referralCode ?? null,
    };
  }

  /** Owner editor payload. Warms the X snapshot in the background when the count is switched on. */
  async getMine(userId: string, opts: { warm?: boolean } = {}): Promise<MyProfileLinksDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, usernameIsSet: true, verifiedStatus: true, ...CONNECTION_SELECT },
    });
    if (!user) throw new NotFoundException('User not found.');
    const verified = user.verifiedStatus !== 'none';

    if (opts.warm !== false && user.showXFollowerCount && this.xHandle(user)) {
      void this.warmXSnapshot(userId);
    }

    const rows = await this.profileLinks.listRows(userId);
    const links: MyProfileLinkDto[] = rows.map((row) => {
      const dto = toProfileLinkDto(row) ?? {
        id: row.id,
        url: row.url,
        title: row.title,
        ...profileLinkDisplay(row.url),
      };
      return { ...dto, grandfathered: row.grandfathered, hiddenUntilVerified: !verified && !row.grandfathered };
    });

    return {
      links,
      connectedAccounts: await this.connectedAccounts(user, { readSnapshot: true }),
      canAddCustomLinks: verified,
      maxLinks: MAX_PROFILE_LINKS,
      path: user.usernameIsSet && user.username ? `/u/${user.username}/links` : null,
    };
  }

  async updateSettings(userId: string, body: unknown): Promise<MyProfileLinksDto> {
    const { showXFollowerCount } = linkSettingsSchema.parse(body);
    await this.linksWrite.setShowXFollowerCount(userId, showXFollowerCount);
    if (showXFollowerCount) await this.warmXSnapshot(userId);
    return this.getMine(userId, { warm: false });
  }

  /** Owner-initiated only; XProfilePreviewService enforces budget, lock, and cold-read limits. */
  private async warmXSnapshot(ownerId: string): Promise<void> {
    try {
      await this.xPreview.get(ownerId, ownerId);
    } catch {
      // Best-effort; the count simply stays hidden until a snapshot exists.
    }
  }

  private xHandle(user: ConnectionSource): string | null {
    const handle = cleanHandle(user.xUsername);
    const connected = user.xConnection?.username?.toLowerCase();
    return handle && connected && connected === handle.toLowerCase() ? handle : null;
  }

  private pickaxHandle(user: ConnectionSource): string | null {
    const handle = cleanHandle(user.pickaxUsername);
    const connected = user.pickaxConnection?.username?.toLowerCase();
    return handle && connected && connected === handle.toLowerCase() ? handle : null;
  }

  private async connectedAccounts(
    user: ConnectionSource,
    opts: { readSnapshot: boolean },
  ): Promise<MyConnectedAccountDto[]> {
    const out: MyConnectedAccountDto[] = [];
    const xHandle = this.xHandle(user);
    if (xHandle && user.xConnection) {
      let followerCount: number | null = null;
      if (user.showXFollowerCount && opts.readSnapshot) {
        // Postgres-only read of an already-fresh snapshot.
        const snapshot = await this.xSnapshots.profile(user.xConnection.xUserId, xHandle.toLowerCase());
        followerCount = snapshot?.followers ?? null;
      }
      out.push({
        network: 'x',
        handle: xHandle,
        url: `https://x.com/${xHandle}`,
        followerCount,
        supportsFollowerCount: true,
        showFollowerCount: user.showXFollowerCount,
      });
    }
    const pickaxHandle = this.pickaxHandle(user);
    if (pickaxHandle) {
      out.push({
        network: 'pickax',
        handle: pickaxHandle,
        url: `https://pickax.com/${pickaxHandle}`,
        followerCount: null,
        supportsFollowerCount: false,
        showFollowerCount: false,
      });
    }
    return out;
  }

  private async recentItems(userId: string): Promise<LinksPageRecentItemDto[]> {
    const [posts, articles] = await Promise.all([
      this.postsRead.findMany({
        where: { ...totalUserPostsWhere(userId), visibility: 'public', parentId: null, kind: { not: 'repost' } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: RECENT_LIMIT,
        select: { id: true, body: true, createdAt: true },
      }),
      this.prisma.article.findMany({
        where: { ...totalUserArticlesWhere(userId), visibility: 'public' },
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: RECENT_LIMIT,
        select: { id: true, title: true, excerpt: true, publishedAt: true, createdAt: true },
      }),
    ]);
    const items: LinksPageRecentItemDto[] = [
      ...posts.map((p: { id: string; body: string; createdAt: Date }) => ({
        kind: 'post' as const,
        id: p.id,
        title: null,
        excerpt: plainExcerpt(p.body),
        createdAt: p.createdAt.toISOString(),
      })),
      ...articles.map(
        (a: { id: string; title: string; excerpt: string | null; publishedAt: Date | null; createdAt: Date }) => ({
          kind: 'article' as const,
          id: a.id,
          title: a.title,
          excerpt: plainExcerpt(a.excerpt),
          createdAt: (a.publishedAt ?? a.createdAt).toISOString(),
        }),
      ),
    ];
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, RECENT_LIMIT);
  }
}
