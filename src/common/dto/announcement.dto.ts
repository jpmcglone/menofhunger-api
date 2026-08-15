import type {
  Announcement,
  AnnouncementDismissMethod,
  AnnouncementPlacement,
  AnnouncementStatus,
} from '@prisma/client';
import { publicAssetUrl } from '../assets/public-asset-url';

export type AnnouncementDto = {
  id: string;
  isAd: boolean;
  placement: AnnouncementPlacement;
  title: string;
  body: string | null;
  imageUrl: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
};

export type AnnouncementStatsDto = {
  uniquePeople: number;
  totalViews: number;
  clicks: number;
  abandoned: number;
  ctr: number;
  dismissMethods: Partial<Record<AnnouncementDismissMethod, number>>;
};

export type AnnouncementAdminDto = AnnouncementDto & {
  status: AnnouncementStatus;
  endsAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  imageKey: string | null;
  stats: AnnouncementStatsDto;
};

export function toAnnouncementDto(
  row: Pick<Announcement, 'id' | 'isAd' | 'placement' | 'title' | 'body' | 'imageKey' | 'imageUpdatedAt' | 'ctaLabel' | 'ctaHref'>,
  publicAssetBaseUrl: string | null,
): AnnouncementDto {
  return {
    id: row.id,
    isAd: row.isAd,
    placement: row.placement,
    title: row.title,
    body: row.body ?? null,
    imageUrl: publicAssetUrl({
      publicBaseUrl: publicAssetBaseUrl,
      key: row.imageKey ?? null,
      updatedAt: row.imageUpdatedAt ?? null,
    }),
    ctaLabel: row.ctaLabel ?? null,
    ctaHref: row.ctaHref ?? null,
  };
}

export function toAnnouncementAdminDto(
  row: Announcement,
  publicAssetBaseUrl: string | null,
  stats: AnnouncementStatsDto,
): AnnouncementAdminDto {
  return {
    ...toAnnouncementDto(row, publicAssetBaseUrl),
    status: row.status,
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    imageKey: row.imageKey ?? null,
    stats,
  };
}

export function emptyAnnouncementStats(): AnnouncementStatsDto {
  return {
    uniquePeople: 0,
    totalViews: 0,
    clicks: 0,
    abandoned: 0,
    ctr: 0,
    dismissMethods: {},
  };
}
