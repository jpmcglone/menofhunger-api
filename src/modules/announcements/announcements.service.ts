import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  Announcement,
  AnnouncementDismissMethod,
  AnnouncementEventType,
  AnnouncementOutcome,
  AnnouncementPlatform,
  AnnouncementStatus,
  Prisma,
} from '@prisma/client';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  emptyAnnouncementStats,
  toAnnouncementAdminDto,
  toAnnouncementDto,
  type AnnouncementAdminDto,
  type AnnouncementDto,
  type AnnouncementStatsDto,
} from '../../common/dto/announcement.dto';
import {
  AD_CADENCE_MS,
  ANNOUNCEMENT_CADENCE_MS,
  canSeeAds,
  isAudienceEligibleForAds,
  isOnboarded,
  pickNextRotatingItem,
  viewerKeyFor,
} from './announcements.selection';

const LIVE_ANNOUNCEMENT_SELECT = {
  id: true,
  isAd: true,
  title: true,
  body: true,
  imageKey: true,
  imageUpdatedAt: true,
  ctaLabel: true,
  ctaHref: true,
  publishedAt: true,
  endsAt: true,
  status: true,
} satisfies Prisma.AnnouncementSelect;

type LiveAnnouncement = Prisma.AnnouncementGetPayload<{ select: typeof LIVE_ANNOUNCEMENT_SELECT }>;

export type AnnouncementWriteInput = {
  title: string;
  body?: string | null;
  isAd?: boolean;
  ctaLabel?: string | null;
  ctaHref?: string | null;
  endsAt?: Date | null;
  imageKey?: string | null;
};

@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
  ) {}

  private publicAssetBaseUrl(): string | null {
    return this.appConfig.r2()?.publicBaseUrl ?? null;
  }

  /**
   * Mid-session sockets are intentionally skipped. Clients fetch on session start only.
   */
  async getPending(input: {
    userId?: string | null;
    anonymousId?: string | null;
    platform: AnnouncementPlatform;
    now?: Date;
  }): Promise<AnnouncementDto | null> {
    const now = input.now ?? new Date();
    const identity = await this.resolveIdentity(input.userId, input.anonymousId);
    if (!identity) return null;

    await this.ensureAudience(identity);

    const user = identity.userId
      ? await this.prisma.user.findUnique({
          where: { id: identity.userId },
          select: {
            createdAt: true,
            premium: true,
            premiumPlus: true,
            usernameIsSet: true,
            birthdate: true,
            interests: true,
            menOnlyConfirmed: true,
          },
        })
      : null;

    if (user && isOnboarded(user)) {
      const announcement = await this.findPendingItem(identity.viewerKey, input.platform, now, false);
      if (announcement) return toAnnouncementDto(announcement, this.publicAssetBaseUrl());
    }

    if (!canSeeAds(user)) return null;

    const firstEligibleAt = user?.createdAt ?? (await this.audienceFirstSeen(identity.viewerKey));
    if (!firstEligibleAt || !isAudienceEligibleForAds(firstEligibleAt, now)) return null;

    const ad = await this.findPendingItem(identity.viewerKey, input.platform, now, true);
    return ad ? toAnnouncementDto(ad, this.publicAssetBaseUrl()) : null;
  }

  async recordEvent(input: {
    announcementId: string;
    userId?: string | null;
    anonymousId?: string | null;
    platform: AnnouncementPlatform;
    type: AnnouncementEventType;
    dismissMethod?: AnnouncementDismissMethod | null;
    now?: Date;
  }): Promise<{ ok: true }> {
    const now = input.now ?? new Date();
    const identity = await this.resolveIdentity(input.userId, input.anonymousId);
    if (!identity) {
      throw new BadRequestException('Sign in or provide an anonymous id to record this event.');
    }

    const announcement = await this.prisma.announcement.findUnique({
      where: { id: input.announcementId },
      select: { id: true },
    });
    if (!announcement) throw new NotFoundException('Announcement not found.');

    await this.ensureAudience(identity);

    const viewer = await this.prisma.announcementViewer.upsert({
      where: {
        announcementId_viewerKey_platform: {
          announcementId: input.announcementId,
          viewerKey: identity.viewerKey,
          platform: input.platform,
        },
      },
      create: {
        announcementId: input.announcementId,
        viewerKey: identity.viewerKey,
        userId: identity.userId,
        anonymousId: identity.anonymousId,
        platform: input.platform,
      },
      update: {
        userId: identity.userId ?? undefined,
        anonymousId: identity.anonymousId ?? undefined,
      },
    });

    const openCycle = this.isOpenPresentCycle(viewer);
    const countedViewThisCycle = openCycle && (viewer.lastOutcome === 'viewed' || viewer.lastOutcome === 'dismissed' || viewer.lastOutcome === 'clicked');
    const data: Prisma.AnnouncementViewerUpdateInput = {
      lastOutcome: input.type as AnnouncementOutcome,
    };

    if (input.type === 'presented') {
      data.presentCount = { increment: 1 };
      data.lastPresentedAt = now;
    } else if (input.type === 'viewed') {
      if (!countedViewThisCycle) data.viewCount = { increment: 1 };
    } else if (input.type === 'dismissed' || input.type === 'clicked') {
      if (openCycle || viewer.lastCompletedAt == null) {
        if (!countedViewThisCycle) data.viewCount = { increment: 1 };
        data.completedCount = { increment: 1 };
        data.lastCompletedAt = now;
        if (input.type === 'clicked') data.clickCount = { increment: 1 };
        if (input.type === 'dismissed') data.lastDismissMethod = input.dismissMethod ?? null;
      }
    } else if (input.type === 'abandoned') {
      data.abandonedCount = { increment: 1 };
    }

    await this.prisma.$transaction([
      this.prisma.announcementViewer.update({
        where: { id: viewer.id },
        data,
      }),
      this.prisma.announcementEvent.create({
        data: {
          announcementId: input.announcementId,
          viewerKey: identity.viewerKey,
          platform: input.platform,
          type: input.type,
          dismissMethod: input.type === 'dismissed' ? (input.dismissMethod ?? null) : null,
        },
      }),
    ]);

    return { ok: true };
  }

  async listAdmin(): Promise<AnnouncementAdminDto[]> {
    const rows = await this.prisma.announcement.findMany({
      orderBy: [{ createdAt: 'desc' }],
    });
    const statsById = await this.statsForIds(rows.map((row) => row.id));
    const baseUrl = this.publicAssetBaseUrl();
    return rows.map((row) => toAnnouncementAdminDto(row, baseUrl, statsById.get(row.id) ?? emptyAnnouncementStats()));
  }

  async getAdmin(id: string): Promise<AnnouncementAdminDto> {
    const row = await this.prisma.announcement.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Announcement not found.');
    const stats = (await this.statsForIds([id])).get(id) ?? emptyAnnouncementStats();
    return toAnnouncementAdminDto(row, this.publicAssetBaseUrl(), stats);
  }

  async create(adminUserId: string, input: AnnouncementWriteInput): Promise<AnnouncementAdminDto> {
    const data = this.toWriteData(input);
    const row = await this.prisma.announcement.create({
      data: {
        ...data,
        createdByAdminId: adminUserId,
      },
    });
    return toAnnouncementAdminDto(row, this.publicAssetBaseUrl(), emptyAnnouncementStats());
  }

  async update(id: string, input: AnnouncementWriteInput): Promise<AnnouncementAdminDto> {
    const existing = await this.prisma.announcement.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Announcement not found.');
    const row = await this.prisma.announcement.update({
      where: { id },
      data: this.toWriteData(input, existing),
    });
    const stats = (await this.statsForIds([id])).get(id) ?? emptyAnnouncementStats();
    return toAnnouncementAdminDto(row, this.publicAssetBaseUrl(), stats);
  }

  async publish(id: string, now = new Date()): Promise<AnnouncementAdminDto> {
    const existing = await this.prisma.announcement.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Announcement not found.');
    const row = await this.prisma.announcement.update({
      where: { id },
      data: {
        status: 'published',
        publishedAt: existing.publishedAt ?? now,
      },
    });
    const stats = (await this.statsForIds([id])).get(id) ?? emptyAnnouncementStats();
    return toAnnouncementAdminDto(row, this.publicAssetBaseUrl(), stats);
  }

  async unpublish(id: string): Promise<AnnouncementAdminDto> {
    const existing = await this.prisma.announcement.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Announcement not found.');
    const row = await this.prisma.announcement.update({
      where: { id },
      data: { status: 'draft' },
    });
    const stats = (await this.statsForIds([id])).get(id) ?? emptyAnnouncementStats();
    return toAnnouncementAdminDto(row, this.publicAssetBaseUrl(), stats);
  }

  async archive(id: string): Promise<AnnouncementAdminDto> {
    const existing = await this.prisma.announcement.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Announcement not found.');
    const row = await this.prisma.announcement.update({
      where: { id },
      data: { status: 'archived' },
    });
    const stats = (await this.statsForIds([id])).get(id) ?? emptyAnnouncementStats();
    return toAnnouncementAdminDto(row, this.publicAssetBaseUrl(), stats);
  }

  private toWriteData(
    input: AnnouncementWriteInput,
    existing?: Announcement,
  ): {
    title: string;
    body: string | null;
    isAd: boolean;
    ctaLabel: string | null;
    ctaHref: string | null;
    endsAt: Date | null;
    imageKey: string | null;
    imageUpdatedAt: Date | null;
  } {
    const title = input.title.trim();
    if (!title) throw new BadRequestException('Title is required.');
    if (title.length > 120) throw new BadRequestException('Title must be 120 characters or fewer.');

    const body = input.body === undefined ? existing?.body ?? null : (input.body?.trim() || null);
    if (body && body.length > 2000) throw new BadRequestException('Body must be 2000 characters or fewer.');

    const isAd = input.isAd ?? existing?.isAd ?? false;

    const ctaLabel = input.ctaLabel === undefined ? existing?.ctaLabel ?? null : (input.ctaLabel?.trim() || null);
    const ctaHref = input.ctaHref === undefined ? existing?.ctaHref ?? null : (input.ctaHref?.trim() || null);
    if ((ctaLabel && !ctaHref) || (!ctaLabel && ctaHref)) {
      throw new BadRequestException('CTA label and link must be set together.');
    }
    if (ctaLabel && ctaLabel.length > 40) throw new BadRequestException('CTA label must be 40 characters or fewer.');
    if (ctaHref && !isAllowedCtaHref(ctaHref)) {
      throw new BadRequestException('CTA link must be an internal path or an https URL.');
    }

    const imageKey = input.imageKey === undefined ? existing?.imageKey ?? null : (input.imageKey?.trim() || null);
    const imageUpdatedAt =
      input.imageKey === undefined
        ? existing?.imageUpdatedAt ?? null
        : imageKey
          ? new Date()
          : null;

    return {
      title,
      body,
      isAd,
      ctaLabel,
      ctaHref,
      endsAt: input.endsAt === undefined ? existing?.endsAt ?? null : input.endsAt,
      imageKey,
      imageUpdatedAt,
    };
  }

  private async findPendingItem(
    viewerKey: string,
    platform: AnnouncementPlatform,
    now: Date,
    isAd: boolean,
  ): Promise<LiveAnnouncement | null> {
    const rows = await this.prisma.announcement.findMany({
      where: this.liveWhere(now, isAd),
      select: LIVE_ANNOUNCEMENT_SELECT,
      orderBy: { publishedAt: 'asc' },
    });
    if (rows.length === 0) return null;

    const viewers = await this.prisma.announcementViewer.findMany({
      where: {
        viewerKey,
        platform,
        announcementId: { in: rows.map((row) => row.id) },
      },
    });
    const viewerById = new Map(viewers.map((row) => [row.announcementId, row]));

    const abandoned = rows.find((row) => {
      const viewer = viewerById.get(row.id);
      if (!viewer?.lastPresentedAt || viewer.lastCompletedAt) return false;
      return viewer.lastOutcome === 'presented' || viewer.lastOutcome === 'viewed' || viewer.lastOutcome === 'abandoned';
    });
    if (abandoned) return abandoned;

    const cadenceMs = isAd ? AD_CADENCE_MS : ANNOUNCEMENT_CADENCE_MS;
    const id = pickNextRotatingItem(
      rows.map((row) => ({
        id: row.id,
        publishedAt: row.publishedAt ?? now,
        lastCompletedAt: viewerById.get(row.id)?.lastCompletedAt ?? null,
      })),
      now,
      cadenceMs,
    );
    return rows.find((row) => row.id === id) ?? null;
  }

  private liveWhere(now: Date, isAd: boolean): Prisma.AnnouncementWhereInput {
    return {
      isAd,
      status: 'published' satisfies AnnouncementStatus,
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    };
  }

  private async resolveIdentity(
    userId?: string | null,
    anonymousId?: string | null,
  ): Promise<{ viewerKey: string; userId: string | null; anonymousId: string | null } | null> {
    const trimmedAnon = anonymousId?.trim() || null;
    const trimmedUser = userId?.trim() || null;
    if (trimmedUser && trimmedAnon) {
      await this.mergeAnonymousIntoUser(trimmedUser, trimmedAnon);
    }
    const viewerKey = viewerKeyFor(trimmedUser, trimmedAnon);
    if (!viewerKey) return null;
    return { viewerKey, userId: trimmedUser, anonymousId: trimmedAnon };
  }

  private async ensureAudience(identity: { viewerKey: string; userId: string | null; anonymousId: string | null }) {
    await this.prisma.announcementAudience.upsert({
      where: { viewerKey: identity.viewerKey },
      create: {
        viewerKey: identity.viewerKey,
        userId: identity.userId,
        anonymousId: identity.anonymousId,
      },
      update: {
        userId: identity.userId ?? undefined,
        anonymousId: identity.anonymousId ?? undefined,
      },
    });
  }

  private async audienceFirstSeen(viewerKey: string): Promise<Date | null> {
    const row = await this.prisma.announcementAudience.findUnique({
      where: { viewerKey },
      select: { firstSeenAt: true },
    });
    return row?.firstSeenAt ?? null;
  }

  private async mergeAnonymousIntoUser(userId: string, anonymousId: string) {
    const anonKey = `anon:${anonymousId}`;
    const userKey = `user:${userId}`;
    const anonViewers = await this.prisma.announcementViewer.findMany({
      where: { viewerKey: anonKey },
    });
    if (anonViewers.length === 0) {
      await this.prisma.announcementAudience.deleteMany({ where: { viewerKey: anonKey } });
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      for (const anon of anonViewers) {
        const existing = await tx.announcementViewer.findUnique({
          where: {
            announcementId_viewerKey_platform: {
              announcementId: anon.announcementId,
              viewerKey: userKey,
              platform: anon.platform,
            },
          },
        });
        if (!existing) {
          await tx.announcementViewer.update({
            where: { id: anon.id },
            data: { viewerKey: userKey, userId, anonymousId },
          });
          continue;
        }
        await tx.announcementViewer.update({
          where: { id: existing.id },
          data: {
            presentCount: existing.presentCount + anon.presentCount,
            viewCount: existing.viewCount + anon.viewCount,
            clickCount: existing.clickCount + anon.clickCount,
            abandonedCount: existing.abandonedCount + anon.abandonedCount,
            completedCount: existing.completedCount + anon.completedCount,
            lastPresentedAt: laterDate(existing.lastPresentedAt, anon.lastPresentedAt),
            lastCompletedAt: laterDate(existing.lastCompletedAt, anon.lastCompletedAt),
            lastOutcome: anon.lastPresentedAt && (!existing.lastPresentedAt || anon.lastPresentedAt > existing.lastPresentedAt)
              ? anon.lastOutcome
              : existing.lastOutcome,
            lastDismissMethod: anon.lastCompletedAt && (!existing.lastCompletedAt || anon.lastCompletedAt > existing.lastCompletedAt)
              ? anon.lastDismissMethod
              : existing.lastDismissMethod,
            anonymousId,
          },
        });
        await tx.announcementViewer.delete({ where: { id: anon.id } });
      }

      await tx.announcementEvent.updateMany({
        where: { viewerKey: anonKey },
        data: { viewerKey: userKey },
      });

      const anonAudience = await tx.announcementAudience.findUnique({ where: { viewerKey: anonKey } });
      if (anonAudience) {
        await tx.announcementAudience.upsert({
          where: { viewerKey: userKey },
          create: {
            viewerKey: userKey,
            userId,
            anonymousId,
            firstSeenAt: anonAudience.firstSeenAt,
          },
          update: {
            userId,
            anonymousId,
            firstSeenAt: anonAudience.firstSeenAt,
          },
        });
        await tx.announcementAudience.delete({ where: { viewerKey: anonKey } });
      }
    });
  }

  private isOpenPresentCycle(viewer: { lastPresentedAt: Date | null; lastCompletedAt: Date | null }): boolean {
    if (!viewer.lastPresentedAt) return false;
    if (!viewer.lastCompletedAt) return true;
    return viewer.lastPresentedAt.getTime() > viewer.lastCompletedAt.getTime();
  }

  private async statsForIds(ids: string[]): Promise<Map<string, AnnouncementStatsDto>> {
    const result = new Map<string, AnnouncementStatsDto>();
    if (ids.length === 0) return result;

    const [viewerGroups, dismissEvents] = await Promise.all([
      this.prisma.announcementViewer.groupBy({
        by: ['announcementId'],
        where: { announcementId: { in: ids } },
        _sum: { viewCount: true, clickCount: true, abandonedCount: true },
        _count: { _all: true },
      }),
      this.prisma.announcementEvent.groupBy({
        by: ['announcementId', 'dismissMethod'],
        where: { announcementId: { in: ids }, type: 'dismissed', dismissMethod: { not: null } },
        _count: { _all: true },
      }),
    ]);

    const uniqueRows = await this.prisma.announcementViewer.groupBy({
      by: ['announcementId'],
      where: { announcementId: { in: ids }, viewCount: { gt: 0 } },
      _count: { _all: true },
    });
    const uniqueById = new Map(uniqueRows.map((row) => [row.announcementId, row._count._all]));

    for (const id of ids) {
      result.set(id, emptyAnnouncementStats());
    }
    for (const row of viewerGroups) {
      const totalViews = row._sum.viewCount ?? 0;
      const clicks = row._sum.clickCount ?? 0;
      result.set(row.announcementId, {
        uniquePeople: uniqueById.get(row.announcementId) ?? 0,
        totalViews,
        clicks,
        abandoned: row._sum.abandonedCount ?? 0,
        ctr: totalViews > 0 ? clicks / totalViews : 0,
        dismissMethods: {},
      });
    }
    for (const row of dismissEvents) {
      if (!row.dismissMethod) continue;
      const stats = result.get(row.announcementId) ?? emptyAnnouncementStats();
      stats.dismissMethods[row.dismissMethod] = row._count._all;
      result.set(row.announcementId, stats);
    }
    return result;
  }
}

function laterDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function isAllowedCtaHref(href: string): boolean {
  if (href.startsWith('/') && !href.startsWith('//')) return true;
  try {
    const url = new URL(href);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}
