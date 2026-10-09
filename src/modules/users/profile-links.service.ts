import { Injectable } from '@nestjs/common';
import type { ProfileLinkDto } from '../../common/dto/profile-links.dto';
import { normalizeProfileLinkUrl, profileLinkDisplay } from '../../common/urls/profile-link-url';
import { PrismaService } from '../prisma/prisma.service';

export const PROFILE_LINK_SELECT = {
  id: true,
  url: true,
  title: true,
  position: true,
  legacyField: true,
  grandfathered: true,
} as const;

export type ProfileLinkRow = {
  id: string;
  url: string;
  title: string;
  position: number;
  legacyField: string | null;
  grandfathered: boolean;
};

/** Unverified owners keep grandfathered (migrated) links public; everything else waits for verification. */
export function isProfileLinkVisible(row: { grandfathered: boolean }, ownerVerified: boolean): boolean {
  return ownerVerified || row.grandfathered;
}

/** Public DTO for a row, re-validating the stored URL. Returns null when it no longer passes URL safety. */
export function toProfileLinkDto(row: ProfileLinkRow): ProfileLinkDto | null {
  const url = normalizeProfileLinkUrl(row.url);
  if (!url) return null;
  const { host, icon } = profileLinkDisplay(url);
  return { id: row.id, url, title: row.title, host, icon };
}

export function toPublicProfileLinkDtos(rows: ProfileLinkRow[], ownerVerified: boolean): ProfileLinkDto[] {
  const out: ProfileLinkDto[] = [];
  for (const row of rows) {
    if (!isProfileLinkVisible(row, ownerVerified)) continue;
    const dto = toProfileLinkDto(row);
    if (dto) out.push(dto);
  }
  return out;
}

/** Read side of profile links (Prisma only, no realtime) so profile payload builders can use it without cycles. */
@Injectable()
export class ProfileLinksService {
  constructor(private readonly prisma: PrismaService) {}

  async listRows(userId: string): Promise<ProfileLinkRow[]> {
    return this.prisma.profileLink.findMany({
      where: { userId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: PROFILE_LINK_SELECT,
    });
  }

  /** Publicly visible links for an owner whose verification status is already known. */
  async listPublicLinks(userId: string, verifiedStatus: string): Promise<ProfileLinkDto[]> {
    return toPublicProfileLinkDtos(await this.listRows(userId), verifiedStatus !== 'none');
  }

  /** Publicly visible links, loading the owner's verification status. */
  async listPublicLinksForUser(userId: string): Promise<ProfileLinkDto[]> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { verifiedStatus: true } });
    if (!user) return [];
    return this.listPublicLinks(userId, user.verifiedStatus);
  }
}
