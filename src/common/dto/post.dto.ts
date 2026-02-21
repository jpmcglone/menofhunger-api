import type {
  Post,
  PostMedia,
  PostMediaKind,
  PostMediaSource,
  PostPoll,
  PostPollOption,
  PostVisibility,
  VerifiedStatus,
} from '@prisma/client';
import { publicAssetUrl } from '../assets/public-asset-url';

/** PostMedia from Prisma already has thumbnailR2Key, durationSeconds, width, height, deletedAt. */
export type PostMediaWithOptional = PostMedia;

export type PostAuthorDto = {
  id: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: VerifiedStatus;
  avatarUrl: string | null;
  /** When true, author is banned; id/username/name/avatar are redacted. */
  authorBanned?: boolean;
};

export type PostMediaDto = {
  id: string;
  kind: PostMediaKind;
  source: PostMediaSource;
  url: string;
  mp4Url: string | null;
  /** Video poster image URL (from thumbnailR2Key). */
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  /** Video duration in seconds. */
  durationSeconds: number | null;
  /** Optional alt text for accessibility. */
  alt: string | null;
  // When present, the media was hard-deleted from storage and should render as a placeholder.
  deletedAt: string | null;
};

export type PostMentionDto = {
  id: string;
  username: string;
  verifiedStatus?: VerifiedStatus;
  premium?: boolean;
  premiumPlus?: boolean;
  isOrganization?: boolean;
  stewardBadgeEnabled?: boolean;
};

export type PostPollOptionDto = {
  id: string;
  text: string;
  imageUrl: string | null;
  width: number | null;
  height: number | null;
  alt: string | null;
  voteCount: number;
  percent: number;
};

export type PostPollDto = {
  id: string;
  endsAt: string;
  ended: boolean;
  totalVoteCount: number;
  viewerHasVoted: boolean;
  viewerVotedOptionId: string | null;
  options: PostPollOptionDto[];
};

export type PostDto = {
  id: string;
  createdAt: string;
  editedAt: string | null;
  editCount: number;
  body: string;
  deletedAt: string | null;
  kind: 'regular' | 'checkin';
  checkinDayKey: string | null;
  checkinPrompt: string | null;
  visibility: PostVisibility;
  isDraft: boolean;
  topics: string[];
  /** User-created hashtags parsed from body text (lowercase, without '#'). */
  hashtags: string[];
  boostCount: number;
  bookmarkCount: number;
  commentCount: number;
  parentId: string | null;
  /** When present, this post is a reply and the parent is included for thread display. */
  parent?: PostDto;
  mentions: PostMentionDto[];
  media: PostMediaDto[];
  poll?: PostPollDto | null;
  viewerHasBoosted?: boolean;
  viewerHasBookmarked?: boolean;
  viewerBookmarkCollectionIds?: string[];
  /** Set when a block exists between viewer and author. 'viewer_blocked' = viewer blocked the author; 'viewer_blocked_by' = author blocked the viewer. */
  viewerBlockStatus?: 'viewer_blocked' | 'viewer_blocked_by' | null;
  internal?: {
    boostScore: number | null;
    boostScoreUpdatedAt: string | null;
    /** Overall popularity score (boost + bookmark + comments, time-decayed). Admin only, from popular feed. */
    score?: number | null;
  };
  author: PostAuthorDto;
  /** When true, post body/media/mentions/poll are redacted and author is placeholder. */
  authorBanned?: boolean;
};

/** Mention row with user included (from Prisma include). */
export type PostMentionWithUser = {
  user: {
    id: string;
    username: string | null;
    verifiedStatus?: VerifiedStatus;
    premium?: boolean;
    premiumPlus?: boolean;
    isOrganization?: boolean;
    stewardBadgeEnabled?: boolean;
  };
};

/** Minimal author row required by toPostDto (avoid `include: { user: true }`). */
export type PostAuthorRow = {
  id: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: VerifiedStatus;
  avatarKey: string | null;
  avatarUpdatedAt: Date | null;
  bannedAt: Date | null;
};

/** Post with relations included for DTO mapping. Post has bookmarkCount, commentCount, parentId from schema. */
export type PostWithAuthorAndMedia = Post & {
  user: PostAuthorRow;
  media: PostMediaWithOptional[];
  mentions?: PostMentionWithUser[];
  poll?: (PostPoll & { options: PostPollOption[] }) | null;
};

export function toPostPollDto(
  poll: (PostPoll & { options: PostPollOption[] }) | null | undefined,
  publicAssetBaseUrl: string | null = null,
  opts?: { viewerVotedOptionId?: string | null },
): PostPollDto | null {
  if (!poll) return null;
  const endsAtIso = poll.endsAt instanceof Date ? poll.endsAt.toISOString() : new Date(poll.endsAt as any).toISOString();
  const ended = new Date(endsAtIso).getTime() <= Date.now();
  const totalVoteCount =
    typeof (poll as any).totalVoteCount === 'number' && Number.isFinite((poll as any).totalVoteCount)
      ? Math.max(0, Math.floor((poll as any).totalVoteCount))
      : 0;
  const viewerVotedOptionId = (opts?.viewerVotedOptionId ?? null) || null;
  const viewerHasVoted = Boolean(viewerVotedOptionId);

  const options = (poll.options ?? [])
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((o): PostPollOptionDto => {
      const voteCount =
        typeof (o as any).voteCount === 'number' && Number.isFinite((o as any).voteCount)
          ? Math.max(0, Math.floor((o as any).voteCount))
          : 0;
      const percent =
        totalVoteCount > 0
          ? Math.round((voteCount / totalVoteCount) * 100)
          : 0;
      const imageUrl = o.imageR2Key
        ? publicAssetUrl({ publicBaseUrl: publicAssetBaseUrl, key: o.imageR2Key })
        : null;
      return {
        id: o.id,
        text: (o.text ?? '').trim(),
        imageUrl: imageUrl || null,
        width: typeof (o as any).imageWidth === 'number' ? ((o as any).imageWidth as number) : (o as any).imageWidth ?? null,
        height: typeof (o as any).imageHeight === 'number' ? ((o as any).imageHeight as number) : (o as any).imageHeight ?? null,
        alt: (o.imageAlt ?? '').trim() || null,
        voteCount,
        percent,
      };
    });

  return {
    id: poll.id,
    endsAt: endsAtIso,
    ended,
    totalVoteCount,
    viewerHasVoted,
    viewerVotedOptionId,
    options,
  };
}

export function toPostDto(
  post: PostWithAuthorAndMedia,
  publicAssetBaseUrl: string | null = null,
  opts?: {
    viewerHasBoosted?: boolean;
    viewerHasBookmarked?: boolean;
    viewerBookmarkCollectionIds?: string[];
    viewerVotedPollOptionId?: string | null;
    viewerBlockStatus?: 'viewer_blocked' | 'viewer_blocked_by' | null;
    includeInternal?: boolean;
    internalOverride?: {
      boostScore?: number | null;
      boostScoreUpdatedAt?: Date | null;
      score?: number | null;
    };
  },
): PostDto {
  const internalBoostScore =
    typeof opts?.internalOverride?.boostScore === 'number' || opts?.internalOverride?.boostScore === null
      ? opts.internalOverride.boostScore
      : post.boostScore ?? null;
  const internalBoostScoreUpdatedAt =
    typeof opts?.internalOverride?.boostScoreUpdatedAt !== 'undefined'
      ? opts.internalOverride.boostScoreUpdatedAt
      : post.boostScoreUpdatedAt ?? null;

  const postDeletedAt =
    post.deletedAt instanceof Date ? post.deletedAt.toISOString() : post.deletedAt ? String(post.deletedAt) : null;
  const isPostDeleted = Boolean(postDeletedAt);

  const media: PostMediaDto[] = (post.media ?? [])
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((m) => {
      const deletedAt = m.deletedAt ? (m.deletedAt instanceof Date ? m.deletedAt.toISOString() : String(m.deletedAt)) : null;
      const isDeleted = Boolean(deletedAt);

      const url = isDeleted
        ? ''
        : m.source === 'upload'
          ? publicAssetUrl({
              publicBaseUrl: publicAssetBaseUrl,
              key: m.r2Key ?? null,
            })
          : (m.url ?? '').trim();
      const thumbnailUrl =
        isDeleted || !m.thumbnailR2Key
          ? null
          : publicAssetUrl({
              publicBaseUrl: publicAssetBaseUrl,
              key: m.thumbnailR2Key,
            });
      const durationSeconds =
        typeof m.durationSeconds === 'number' && Number.isFinite(m.durationSeconds)
          ? Math.max(0, Math.floor(m.durationSeconds))
          : null;
      return {
        id: m.id,
        kind: m.kind,
        source: m.source,
        url: url || '',
        mp4Url: m.mp4Url ?? null,
        thumbnailUrl: thumbnailUrl || null,
        width: typeof m.width === 'number' ? m.width : m.width ?? null,
        height: typeof m.height === 'number' ? m.height : m.height ?? null,
        durationSeconds: durationSeconds ?? null,
        alt: (m.alt ?? '').trim() || null,
        deletedAt: deletedAt || null,
      };
    })
    .filter((m) => Boolean(m.url) || Boolean(m.deletedAt));

  const mentions: PostMentionDto[] = (post.mentions ?? [])
    .map((m: PostMentionWithUser): PostMentionDto | null =>
      m.user?.id != null && m.user?.username != null
        ? {
            id: m.user.id,
            username: m.user.username,
            verifiedStatus: m.user.verifiedStatus ?? undefined,
            premium: m.user.premium ?? undefined,
            premiumPlus: m.user.premiumPlus ?? undefined,
            isOrganization: m.user.isOrganization ?? undefined,
            stewardBadgeEnabled: m.user.stewardBadgeEnabled ?? undefined,
          }
        : null,
    )
    .filter((x): x is PostMentionDto => x != null);

  const pollDto = toPostPollDto(post.poll ?? null, publicAssetBaseUrl, {
    viewerVotedOptionId: opts?.viewerVotedPollOptionId ?? null,
  });

  const authorBanned = Boolean((post.user as { bannedAt?: Date | null }).bannedAt);

  if (authorBanned) {
    return {
      id: post.id,
      createdAt: post.createdAt.toISOString(),
      editedAt: post.editedAt ? post.editedAt.toISOString() : null,
      editCount: 0,
      body: '[Content from banned user]',
      deletedAt: postDeletedAt,
      kind: ((post as any).kind ?? 'regular') as any,
      checkinDayKey: (post as any).checkinDayKey ? String((post as any).checkinDayKey) : null,
      checkinPrompt: (post as any).checkinPrompt ? String((post as any).checkinPrompt) : null,
      visibility: post.visibility,
      isDraft: Boolean((post as any).isDraft),
      topics: [],
      hashtags: [],
      boostCount: post.boostCount,
      bookmarkCount: post.bookmarkCount ?? 0,
      commentCount: post.commentCount ?? 0,
      parentId: post.parentId ?? null,
      mentions: [],
      media: [],
      poll: null,
      author: {
        id: '[banned]',
        username: null,
        name: 'User is banned',
        premium: false,
        premiumPlus: false,
        isOrganization: false,
        stewardBadgeEnabled: false,
        verifiedStatus: 'none',
        avatarUrl: null,
        authorBanned: true,
      },
      authorBanned: true,
    };
  }

  return {
    id: post.id,
    createdAt: post.createdAt.toISOString(),
    editedAt: post.editedAt ? post.editedAt.toISOString() : null,
    editCount: typeof (post as any).editCount === 'number' ? ((post as any).editCount as number) : 0,
    body: isPostDeleted ? '' : post.body,
    deletedAt: postDeletedAt,
    kind: ((post as any).kind ?? 'regular') as any,
    checkinDayKey: (post as any).checkinDayKey ? String((post as any).checkinDayKey) : null,
    checkinPrompt: (post as any).checkinPrompt ? String((post as any).checkinPrompt) : null,
    visibility: post.visibility,
    isDraft: Boolean((post as any).isDraft),
    topics: Array.isArray((post as any).topics) ? ((post as any).topics as string[]) : [],
    hashtags: isPostDeleted ? [] : (Array.isArray((post as any).hashtags) ? ((post as any).hashtags as string[]) : []),
    boostCount: post.boostCount,
    bookmarkCount: post.bookmarkCount ?? 0,
    commentCount: post.commentCount ?? 0,
    parentId: post.parentId ?? null,
    mentions: isPostDeleted ? [] : mentions,
    media: isPostDeleted ? [] : media,
    ...(typeof (post as any).poll !== 'undefined' ? { poll: isPostDeleted ? null : pollDto } : {}),
    ...(typeof opts?.viewerHasBoosted === 'boolean' ? { viewerHasBoosted: opts.viewerHasBoosted } : {}),
    ...(typeof opts?.viewerHasBookmarked === 'boolean' ? { viewerHasBookmarked: opts.viewerHasBookmarked } : {}),
    ...(Array.isArray(opts?.viewerBookmarkCollectionIds) ? { viewerBookmarkCollectionIds: opts.viewerBookmarkCollectionIds } : {}),
    ...(typeof opts?.viewerBlockStatus !== 'undefined' ? { viewerBlockStatus: opts.viewerBlockStatus ?? null } : {}),
    ...(opts?.includeInternal
      ? {
          internal: {
            boostScore: internalBoostScore,
            boostScoreUpdatedAt: internalBoostScoreUpdatedAt ? internalBoostScoreUpdatedAt.toISOString() : null,
            ...(typeof opts?.internalOverride?.score === 'number' || opts?.internalOverride?.score === null
              ? { score: opts.internalOverride.score }
              : {}),
          },
        }
      : {}),
    author: {
      id: post.user.id,
      username: post.user.username,
      name: post.user.name,
      premium: post.user.premium,
      premiumPlus: post.user.premiumPlus,
      isOrganization: Boolean((post.user as any).isOrganization),
      stewardBadgeEnabled: Boolean(post.user.stewardBadgeEnabled),
      verifiedStatus: post.user.verifiedStatus,
      avatarUrl: publicAssetUrl({
        publicBaseUrl: publicAssetBaseUrl,
        key: post.user.avatarKey ?? null,
        updatedAt: post.user.avatarUpdatedAt ?? null,
      }),
    },
  };
}
