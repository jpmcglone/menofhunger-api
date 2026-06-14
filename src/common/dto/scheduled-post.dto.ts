import type { PostVisibility } from '@prisma/client';
import type { PostMediaDto, PostMediaWithOptional, PostMentionWithUser, PostAuthorRow } from './post.dto';
import { publicAssetUrl } from '../assets/public-asset-url';

export type ScheduledPollOptionPreviewDto = {
  text: string;
};

export type ScheduledPollPreviewDto = {
  options: ScheduledPollOptionPreviewDto[];
  durationHours: number;
};

export type ScheduledCommunityGroupDto = {
  id: string;
  slug: string;
  name: string;
};

/**
 * Holding-row DTO returned by the scheduled-posts endpoints.
 * Carries the intended publish settings alongside the composed body/media/poll preview.
 */
export type ScheduledPostDto = {
  id: string;
  createdAt: string;
  body: string;
  /** Intended visibility when the post publishes. */
  scheduledVisibility: PostVisibility;
  /** UTC ISO string — when the post will be auto-published. */
  scheduledAt: string;
  /** Intended community group id (null for global posts). */
  scheduledCommunityGroupId: string | null;
  /** Minimal group preview — present when this post is destined for a group. */
  scheduledCommunityGroup: ScheduledCommunityGroupDto | null;
  media: PostMediaDto[];
  /** Poll preview (options + duration) as entered — not yet a live poll. */
  poll: ScheduledPollPreviewDto | null;
  /** Set when the last publish attempt failed. */
  scheduledError: string | null;
  /** ISO timestamp of the last failed attempt. */
  scheduledFailedAt: string | null;
};

type ScheduledPostRow = {
  id: string;
  createdAt: Date;
  body: string;
  scheduledAt: Date | null;
  scheduledVisibility: PostVisibility | null;
  scheduledCommunityGroupId: string | null;
  scheduledCommunityGroup?: { id: string; slug: string; name: string } | null;
  scheduledPollJson: unknown;
  scheduledError: string | null;
  scheduledFailedAt: Date | null;
  user: PostAuthorRow;
  media: PostMediaWithOptional[];
  mentions?: PostMentionWithUser[];
};

export function toScheduledPostDto(
  post: ScheduledPostRow,
  publicAssetBaseUrl: string | null = null,
): ScheduledPostDto {
  const media: PostMediaDto[] = (post.media ?? [])
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((m) => ({
      id: m.id,
      kind: m.kind,
      source: m.source,
      url:
        (m.r2Key
          ? publicAssetUrl({ publicBaseUrl: publicAssetBaseUrl, key: m.r2Key })
          : (m.url ?? null)) ?? '',
      mp4Url: m.mp4Url ?? null,
      thumbnailUrl: m.thumbnailR2Key
        ? publicAssetUrl({ publicBaseUrl: publicAssetBaseUrl, key: m.thumbnailR2Key })
        : null,
      width: m.width ?? null,
      height: m.height ?? null,
      durationSeconds: m.durationSeconds ?? null,
      alt: m.alt ?? null,
      deletedAt: m.deletedAt ? m.deletedAt.toISOString() : null,
    }));

  const rawPoll = post.scheduledPollJson as { options?: { text: string }[]; durationHours?: number } | null;
  const poll: ScheduledPollPreviewDto | null =
    rawPoll?.options?.length
      ? {
          options: rawPoll.options.map((o) => ({ text: o.text })),
          durationHours: rawPoll.durationHours ?? 24,
        }
      : null;

  const group = post.scheduledCommunityGroup
    ? { id: post.scheduledCommunityGroup.id, slug: post.scheduledCommunityGroup.slug, name: post.scheduledCommunityGroup.name }
    : null;

  return {
    id: post.id,
    createdAt: post.createdAt.toISOString(),
    body: post.body,
    scheduledAt: (post.scheduledAt ?? new Date()).toISOString(),
    scheduledVisibility: post.scheduledVisibility ?? 'public',
    scheduledCommunityGroupId: post.scheduledCommunityGroupId ?? null,
    scheduledCommunityGroup: group,
    media,
    poll,
    scheduledError: post.scheduledError ?? null,
    scheduledFailedAt: post.scheduledFailedAt ? post.scheduledFailedAt.toISOString() : null,
  };
}
