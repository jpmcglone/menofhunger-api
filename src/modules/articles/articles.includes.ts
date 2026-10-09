import { articleAuthorInclude } from '../../common/dto/article.dto';
import type { AppConfigService } from '../app/app-config.service';
import { NOT_DELETED } from '../../common/prisma/where';

const authorSelect = { select: articleAuthorInclude };

export function articleIncludes(includeReactions = true, includeBoosts = true, viewerUserId?: string | null) {
  return {
    author: authorSelect,
    tags: { select: { tag: true, label: true }, orderBy: { createdAt: 'asc' as const } },
    // Select only the fields needed by buildReactionSummaries (avoids loading all columns for every row).
    ...(includeReactions ? { reactions: { select: { reactionId: true, emoji: true, userId: true } } } : {}),
    ...(includeBoosts
      ? {
          boosts: viewerUserId ? { where: { userId: viewerUserId }, select: { userId: true }, take: 1 } : false,
        }
      : {}),
  };
}

export function commentLeafIncludes() {
  return { author: authorSelect, reactions: true };
}

export function commentIncludes() {
  return {
    author: authorSelect,
    reactions: true,
    replies: {
      where: NOT_DELETED,
      orderBy: { createdAt: 'asc' as const },
      take: 3,
      include: commentLeafIncludes(),
    },
  };
}

export function articleR2BaseUrl(appConfig: AppConfigService): string | null {
  return appConfig.r2()?.publicBaseUrl ?? null;
}
