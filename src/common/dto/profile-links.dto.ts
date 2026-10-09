import type { VerifiedStatus } from '@prisma/client';
import type { AvatarVideoDto } from './avatar-video.dto';

/** Clients treat an unknown icon as 'website'. */
export type ProfileLinkIcon =
  | 'website'
  | 'x'
  | 'pickax'
  | 'youtube'
  | 'rumble'
  | 'linkedin'
  | 'substack'
  | 'ghost'
  | 'github'
  | 'soundcloud'
  | 'bandcamp'
  | 'etsy'
  | 'gumroad'
  | 'sketchfab'
  | 'tiktok'
  | 'locals'
  | 'facebook'
  | 'instagram'
  | 'spotify';

export type ProfileLinkDto = { id: string; url: string; title: string; host: string; icon: ProfileLinkIcon };

export type ConnectedAccountDto = {
  network: 'x' | 'pickax';
  handle: string;
  url: string;
  followerCount: number | null;
};

export type LinksPageRecentItemDto = {
  kind: 'post' | 'article';
  id: string;
  title: string | null;
  excerpt: string;
  createdAt: string;
};

export type LinksPageDto = {
  user: {
    id: string;
    username: string;
    name: string | null;
    bio: string | null;
    locationDisplay: string | null;
    verifiedStatus: VerifiedStatus;
    isOrganization: boolean;
    premium: boolean;
    premiumPlus: boolean;
    avatarUrl: string | null;
    avatarVideo?: AvatarVideoDto | null;
  };
  connectedAccounts: ConnectedAccountDto[];
  links: ProfileLinkDto[];
  /** At most 3 items. */
  recent: LinksPageRecentItemDto[];
  referralCode: string | null;
};

export type MyProfileLinkDto = ProfileLinkDto & { grandfathered: boolean; hiddenUntilVerified: boolean };

export type MyConnectedAccountDto = ConnectedAccountDto & {
  supportsFollowerCount: boolean;
  showFollowerCount: boolean;
};

export type MyProfileLinksDto = {
  links: MyProfileLinkDto[];
  connectedAccounts: MyConnectedAccountDto[];
  canAddCustomLinks: boolean;
  maxLinks: number;
  path: string | null;
};
