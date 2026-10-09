import { resolveMarvVisionUrl } from "./marvin-vision-media";
import { STOPWORDS } from "./marvin-tool-handlers.schemas";
import { NOT_DELETED } from '../../../common/prisma/where';

export function marvPostSelect() {
  return {
    id: true,
    body: true,
    createdAt: true,
    visibility: true,
    rootId: true,
    parentId: true,
    checkinPrompt: true,
    user: { select: { username: true, name: true, isBot: true } },
    media: {
      where: NOT_DELETED,
      select: {
        kind: true,
        source: true,
        r2Key: true,
        url: true,
        thumbnailR2Key: true,
      },
      orderBy: { position: "asc" as const },
      take: 8,
    },
    poll: {
      select: {
        totalVoteCount: true,
        options: {
          select: { text: true, voteCount: true },
          orderBy: { position: "asc" as const },
        },
      },
    },
  };
}

export function compactMarvPost(
  post: {
    id: string;
    body: string | null;
    createdAt: Date;
    visibility?: string;
    rootId: string | null;
    parentId: string | null;
    checkinPrompt?: string | null;
    user: { username: string | null; name: string | null; isBot: boolean };
    media?: Array<{
      kind: string;
      source: string;
      r2Key: string | null;
      url: string | null;
      thumbnailR2Key?: string | null;
    }>;
    poll?: {
      totalVoteCount: number;
      options: Array<{ text: string; voteCount: number }>;
    } | null;
  },
  publicBaseUrl: string | null,
  opts: { bodyMax: number },
) {
  const imageUrls: string[] = [];
  for (const media of post.media ?? []) {
    const url = resolveMarvVisionUrl(media, publicBaseUrl);
    if (url) imageUrls.push(url);
  }
  return {
    id: post.id,
    body: (post.body ?? "").slice(0, opts.bodyMax),
    createdAt: post.createdAt.toISOString(),
    visibility: post.visibility ?? "public",
    rootId: post.rootId,
    parentId: post.parentId,
    checkinPrompt: post.checkinPrompt ?? null,
    author: {
      username: post.user.username,
      displayName: post.user.name,
      isBot: post.user.isBot,
    },
    media: (post.media ?? []).map((m) => m.kind),
    imageUrls: imageUrls.slice(0, 4),
    poll: compactPoll(post.poll),
  };
}

export function rankMembersByConversation<T extends { username: string }>(
  members: T[],
  conversationUsernames: string[],
): T[] {
  const rank = new Map(
    conversationUsernames.map((username, index) => [
      username.toLowerCase(),
      index,
    ]),
  );
  return [...members].sort((a, b) => {
    const aRank = rank.get(a.username.toLowerCase());
    const bRank = rank.get(b.username.toLowerCase());
    if (aRank == null && bRank == null) return 0;
    if (aRank == null) return 1;
    if (bRank == null) return -1;
    return aRank - bRank;
  });
}

export function tokenizeForSimilarity(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .slice(0, 24);
}

export function compactPoll(
  poll:
    | {
        totalVoteCount: number;
        options: Array<{ text: string; voteCount: number }>;
      }
    | null
    | undefined,
): {
  totalVoteCount: number;
  options: Array<{ text: string; voteCount: number }>;
} | null {
  if (!poll) return null;
  return {
    totalVoteCount: poll.totalVoteCount,
    options: poll.options.map((o) => ({
      text: o.text,
      voteCount: o.voteCount,
    })),
  };
}
