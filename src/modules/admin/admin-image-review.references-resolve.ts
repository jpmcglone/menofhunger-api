import { Prisma } from '@prisma/client';
import { isProtectedChannelKey } from '../group-channels/channel-media.service';
import {
  articleBodyContainsKey,
  matchStoredAssetToKey,
} from './admin-image-review.references';
import type {
  AdminImageReviewService,
  AssetRefs,
  MessageRef,
  PostRef,
  UserRef,
} from './admin-image-review.service';

function emptyAssetRefs(): AssetRefs {
  return { channelUploads: [], posts: [], messages: [], users: [], groups: [], crews: [], polls: [], articles: [], announcements: [], newsletters: [], primaryType: 'orphan' };
}

export async function resolveAllReferencesOn(host: AdminImageReviewService, keys: string[]): Promise<Map<string, AssetRefs>> {
  const result = new Map<string, AssetRefs>();
  const keySet = new Set(keys.filter(Boolean));

  for (const key of keySet) {
    result.set(key, emptyAssetRefs());
  }

  if (!keySet.size) return result;

  const keyArr = [...keySet];
  const protectedKeys = keyArr.filter(isProtectedChannelKey);
  if (protectedKeys.length) {
    const uploads = await host.prisma.groupChannelUpload.findMany({ where: {
      expiresAt: { gt: new Date() }, OR: [{ sourceKey: { in: protectedKeys } }, { r2Key: { in: protectedKeys } }],
    }, select: {
      id: true, channelId: true, userId: true, sourceKey: true, r2Key: true, expiresAt: true,
      user: { select: { username: true } },
      channel: { select: { name: true, displayName: true, groupId: true, group: { select: { name: true, slug: true } } } },
    } });
    for (const upload of uploads) for (const key of [upload.sourceKey, upload.r2Key]) {
      result.get(key)?.channelUploads.push({
        uploadId: upload.id, channelId: upload.channelId, userId: upload.userId, username: upload.user.username,
        channelName: upload.channel.displayName ?? upload.channel.name, groupId: upload.channel.groupId,
        groupName: upload.channel.group.name, groupSlug: upload.channel.group.slug, expiresAt: upload.expiresAt.toISOString(),
      });
    }
  }


  // ── 1. PostMedia (r2Key + thumbnailR2Key) ──────────────────────────────
  const postMediaRows = await host.prisma.postMedia.findMany({
    where: { OR: [{ r2Key: { in: keyArr } }, { thumbnailR2Key: { in: keyArr } }] },
    select: {
      id: true,
      postId: true,
      r2Key: true,
      thumbnailR2Key: true,
      deletedAt: true,
      post: {
        select: {
          id: true,
          createdAt: true,
          visibility: true,
          user: { select: { id: true, username: true } },
        },
      },
    },
    orderBy: [{ createdAt: 'desc' }],
  });
  for (const m of postMediaRows) {
    const base: PostRef = {
      postMediaId: m.id,
      postId: m.postId,
      postCreatedAt: m.post.createdAt.toISOString(),
      postVisibility: m.post.visibility,
      authorId: m.post.user.id,
      authorUsername: m.post.user.username ?? null,
      deletedAt: m.deletedAt ? m.deletedAt.toISOString() : null,
      isThumbnail: false,
    };
    if (m.r2Key && keySet.has(m.r2Key)) {
      result.get(m.r2Key)!.posts.push(base);
    }
    if (m.thumbnailR2Key && keySet.has(m.thumbnailR2Key)) {
      result.get(m.thumbnailR2Key)!.posts.push({ ...base, isThumbnail: true });
    }
  }

  // ── 2. MessageMedia (r2Key + thumbnailR2Key) ───────────────────────────
  const msgMediaRows = await host.prisma.messageMedia.findMany({
    where: { OR: [{ r2Key: { in: keyArr } }, { thumbnailR2Key: { in: keyArr } }] },
    select: {
      id: true,
      messageId: true,
      r2Key: true,
      thumbnailR2Key: true,
      message: { select: {
        conversationId: true, createdAt: true,
        sender: { select: { id: true, username: true, name: true } },
        conversation: { select: { groupChannel: { select: { id: true, name: true, displayName: true, privacy: true, groupId: true, group: { select: { name: true, slug: true } } } } } },
      } },
    },
  });
  for (const m of msgMediaRows) {
    const base: MessageRef = {
      messageMediaId: m.id,
      messageId: m.messageId,
      conversationId: m.message.conversationId,
      sentAt: m.message.createdAt.toISOString(),
      senderId: m.message.sender.id,
      senderUsername: m.message.sender.username,
      senderName: m.message.sender.name,
      ...(m.message.conversation?.groupChannel ? {
        channelId: m.message.conversation.groupChannel.id,
        channelName: m.message.conversation.groupChannel.displayName ?? m.message.conversation.groupChannel.name,
        channelPrivacy: m.message.conversation.groupChannel.privacy,
        groupId: m.message.conversation.groupChannel.groupId,
        groupName: m.message.conversation.groupChannel.group.name,
        groupSlug: m.message.conversation.groupChannel.group.slug,
      } : {}),
      isThumbnail: false,
    };
    if (m.r2Key && keySet.has(m.r2Key)) {
      result.get(m.r2Key)!.messages.push(base);
    }
    if (m.thumbnailR2Key && keySet.has(m.thumbnailR2Key)) {
      result.get(m.thumbnailR2Key)!.messages.push({ ...base, isThumbnail: true });
    }
  }

  // ── 3. User (photo/poster + avatar MP4 + banner) ───────────────────────
  const userRows = await host.prisma.user.findMany({
    where: { OR: [{ avatarKey: { in: keyArr } }, { avatarVideoKey: { in: keyArr } }, { bannerKey: { in: keyArr } }] },
    select: {
      id: true,
      username: true,
      name: true,
      premium: true,
      premiumPlus: true,
      verifiedStatus: true,
      avatarKey: true, avatarVideoKey: true, avatarVideoDurationMs: true,
      bannerKey: true,
    },
  });
  for (const u of userRows) {
    const base: UserRef = {
      userId: u.id,
      username: u.username ?? null,
      name: u.name ?? null,
      premium: u.premium,
      premiumPlus: u.premiumPlus,
      verifiedStatus: u.verifiedStatus ?? null,
      isAvatar: false,
      isBanner: false,
    };
    if (u.avatarKey && keySet.has(u.avatarKey)) {
      result.get(u.avatarKey)!.users.push({ ...base, isAvatar: true });
    }
    if (u.avatarVideoKey && keySet.has(u.avatarVideoKey)) {
      result.get(u.avatarVideoKey)!.users.push({ ...base, isAvatar: true });
    }
    if (u.bannerKey && keySet.has(u.bannerKey)) {
      result.get(u.bannerKey)!.users.push({ ...base, isBanner: true });
    }
  }

  const avatarUploads = await host.prisma.avatarVideoUpload.findMany({
    where: { OR: [{ sourceKey: { in: keyArr } }, { videoKey: { in: keyArr } }, { posterKey: { in: keyArr } }] },
    include: { user: { select: { id: true, username: true, name: true, premium: true, premiumPlus: true, verifiedStatus: true } } },
  });
  for (const upload of avatarUploads) {
    for (const key of [upload.sourceKey, upload.videoKey, upload.posterKey]) {
      if (!keySet.has(key)) continue;
      const refs = result.get(key)!.users;
      if (!refs.some(ref => ref.userId === upload.userId)) refs.push({ userId: upload.userId,
        username: upload.user.username, name: upload.user.name, premium: upload.user.premium,
        premiumPlus: upload.user.premiumPlus, verifiedStatus: upload.user.verifiedStatus, isAvatar: true, isBanner: false });
    }
  }

  // ── 4. CommunityGroup + Crew (full CDN URL, or rarely a raw R2 key) ─────
  // Match exact URL, URL without ?v=, raw key, or pathname suffix /{key}.
  const urlToKey = new Map<string, string>();
  const publicBase = host.cfg.r2()?.publicBaseUrl ?? null;
  if (publicBase) {
    for (const key of keySet) {
      const url = host.publicUrlForKey(key);
      if (url) urlToKey.set(url, key);
    }
  } else {
    host.logger.warn(
      '[media-review] R2 publicBaseUrl not configured — group/crew URL matching is limited to raw keys / path suffix',
    );
  }

  const urlArr = [...urlToKey.keys()];
  const groupOrCrewWhere: Prisma.CommunityGroupWhereInput = {
    OR: [
      ...(urlArr.length
        ? [{ avatarImageUrl: { in: urlArr } }, { coverImageUrl: { in: urlArr } }]
        : []),
      { avatarImageUrl: { in: keyArr } },
      { coverImageUrl: { in: keyArr } },
    ],
  };

  const groupRows = await host.prisma.communityGroup.findMany({
    where: groupOrCrewWhere,
    select: { id: true, slug: true, name: true, avatarImageUrl: true, coverImageUrl: true },
  });
  for (const g of groupRows) {
    const avatarKey = matchStoredAssetToKey(g.avatarImageUrl, keySet, urlToKey);
    if (avatarKey) {
      result.get(avatarKey)!.groups.push({
        groupId: g.id,
        slug: g.slug,
        name: g.name,
        isAvatar: true,
        isCover: false,
      });
    }
    const coverKey = matchStoredAssetToKey(g.coverImageUrl, keySet, urlToKey);
    if (coverKey) {
      result.get(coverKey)!.groups.push({
        groupId: g.id,
        slug: g.slug,
        name: g.name,
        isAvatar: false,
        isCover: true,
      });
    }
  }

  // Path-suffix fallback for host/CDN drift (exact IN miss). Cap scan size.
  const unresolvedForGroups = [...keySet].filter((k) => result.get(k)!.groups.length === 0);
  if (unresolvedForGroups.length > 0) {
    const suffixGroups = await host.prisma.communityGroup.findMany({
      where: {
        OR: unresolvedForGroups.flatMap((k) => [
          { avatarImageUrl: { contains: k } },
          { coverImageUrl: { contains: k } },
        ]),
      },
      select: { id: true, slug: true, name: true, avatarImageUrl: true, coverImageUrl: true },
    });
    for (const g of suffixGroups) {
      const avatarKey = matchStoredAssetToKey(g.avatarImageUrl, keySet, urlToKey);
      if (avatarKey && !result.get(avatarKey)!.groups.some((x) => x.groupId === g.id && x.isAvatar)) {
        result.get(avatarKey)!.groups.push({
          groupId: g.id,
          slug: g.slug,
          name: g.name,
          isAvatar: true,
          isCover: false,
        });
      }
      const coverKey = matchStoredAssetToKey(g.coverImageUrl, keySet, urlToKey);
      if (coverKey && !result.get(coverKey)!.groups.some((x) => x.groupId === g.id && x.isCover)) {
        result.get(coverKey)!.groups.push({
          groupId: g.id,
          slug: g.slug,
          name: g.name,
          isAvatar: false,
          isCover: true,
        });
      }
    }
  }

  const crewRows = await host.prisma.crew.findMany({
    where: {
      OR: [
        ...(urlArr.length
          ? [{ avatarImageUrl: { in: urlArr } }, { coverImageUrl: { in: urlArr } }]
          : []),
        { avatarImageUrl: { in: keyArr } },
        { coverImageUrl: { in: keyArr } },
      ],
    },
    select: { id: true, slug: true, name: true, avatarImageUrl: true, coverImageUrl: true },
  });
  for (const c of crewRows) {
    const avatarKey = matchStoredAssetToKey(c.avatarImageUrl, keySet, urlToKey);
    if (avatarKey) {
      result.get(avatarKey)!.crews.push({
        crewId: c.id,
        slug: c.slug,
        name: c.name ?? null,
        isAvatar: true,
        isCover: false,
      });
    }
    const coverKey = matchStoredAssetToKey(c.coverImageUrl, keySet, urlToKey);
    if (coverKey) {
      result.get(coverKey)!.crews.push({
        crewId: c.id,
        slug: c.slug,
        name: c.name ?? null,
        isAvatar: false,
        isCover: true,
      });
    }
  }

  const unresolvedForCrews = [...keySet].filter((k) => result.get(k)!.crews.length === 0);
  if (unresolvedForCrews.length > 0) {
    const suffixCrews = await host.prisma.crew.findMany({
      where: {
        OR: unresolvedForCrews.flatMap((k) => [
          { avatarImageUrl: { contains: k } },
          { coverImageUrl: { contains: k } },
        ]),
      },
      select: { id: true, slug: true, name: true, avatarImageUrl: true, coverImageUrl: true },
    });
    for (const c of suffixCrews) {
      const avatarKey = matchStoredAssetToKey(c.avatarImageUrl, keySet, urlToKey);
      if (avatarKey && !result.get(avatarKey)!.crews.some((x) => x.crewId === c.id && x.isAvatar)) {
        result.get(avatarKey)!.crews.push({
          crewId: c.id,
          slug: c.slug,
          name: c.name ?? null,
          isAvatar: true,
          isCover: false,
        });
      }
      const coverKey = matchStoredAssetToKey(c.coverImageUrl, keySet, urlToKey);
      if (coverKey && !result.get(coverKey)!.crews.some((x) => x.crewId === c.id && x.isCover)) {
        result.get(coverKey)!.crews.push({
          crewId: c.id,
          slug: c.slug,
          name: c.name ?? null,
          isAvatar: false,
          isCover: true,
        });
      }
    }
  }

  // ── 5. PostPollOption (imageR2Key) ─────────────────────────────────────
  const pollOptionRows = await host.prisma.postPollOption.findMany({
    where: { imageR2Key: { in: keyArr } },
    select: {
      id: true,
      pollId: true,
      imageR2Key: true,
      poll: { select: { postId: true } },
    },
  });
  for (const o of pollOptionRows) {
    if (!o.imageR2Key || !keySet.has(o.imageR2Key)) continue;
    result.get(o.imageR2Key)!.polls.push({
      pollOptionId: o.id,
      pollId: o.pollId,
      postId: o.poll.postId,
    });
  }

  // ── 6. Article cover thumbnails (thumbnailR2Key) ───────────────────────
  const articleThumbRows = await host.prisma.article.findMany({
    where: { thumbnailR2Key: { in: keyArr } },
    select: { id: true, slug: true, title: true, thumbnailR2Key: true, authorId: true },
  });
  for (const a of articleThumbRows) {
    if (!a.thumbnailR2Key || !keySet.has(a.thumbnailR2Key)) continue;
    result.get(a.thumbnailR2Key)!.articles.push({
      articleId: a.id,
      slug: a.slug,
      title: a.title ?? null,
      authorId: a.authorId,
      isInline: false,
    });
  }

  // ── 7. Article inline TipTap body embeds (article-media/ URLs in JSON) ──
  // Editors store full CDN URLs in image attrs.src; the R2 key is a substring.
  // Only scan keys that still have zero references — those are the false-positive orphans.
  const keysNeedingBodyScan = keyArr.filter((k) => {
    const r = result.get(k)!;
    return (
      r.posts.length === 0 &&
      r.messages.length === 0 &&
      r.users.length === 0 &&
      r.groups.length === 0 &&
      r.crews.length === 0 &&
      r.polls.length === 0 &&
      r.articles.length === 0
    );
  });
  if (keysNeedingBodyScan.length > 0) {
    const bodyArticles = await host.prisma.article.findMany({
      where: {
        OR: keysNeedingBodyScan.map((k) => ({ body: { contains: k } })),
      },
      select: { id: true, slug: true, title: true, authorId: true, body: true },
    });
    for (const a of bodyArticles) {
      for (const key of keysNeedingBodyScan) {
        if (!articleBodyContainsKey(a.body, key)) continue;
        const bucket = result.get(key)!;
        if (bucket.articles.some((x) => x.articleId === a.id && x.isInline)) continue;
        bucket.articles.push({
          articleId: a.id,
          slug: a.slug,
          title: a.title ?? null,
          authorId: a.authorId,
          isInline: true,
        });
      }
    }
  }

  // Publication media remains in use in every lifecycle state. Sent email images
  // must keep working even after the send is over; draft assets are not orphans.
  const publications = await host.resolvePublicationReferences(keyArr);
  for (const [key, refs] of publications) {
    result.get(key)!.announcements = refs.announcements;
    result.get(key)!.newsletters = refs.newsletters;
  }

  // ── Determine primaryType for each key ─────────────────────────────────
  for (const refs of result.values()) {
    if (refs.posts.some((p) => !p.isThumbnail)) refs.primaryType = 'post';
    else if (refs.messages.some((m) => !m.isThumbnail)) refs.primaryType = 'message';
    else if (refs.users.length > 0) refs.primaryType = 'user';
    else if (refs.groups.length > 0) refs.primaryType = 'group';
    else if (refs.crews.length > 0) refs.primaryType = 'crew';
    else if (refs.polls.length > 0) refs.primaryType = 'poll';
    else if (refs.articles.some((a) => !a.isInline)) refs.primaryType = 'article';
    else if (refs.articles.some((a) => a.isInline)) refs.primaryType = 'article_inline';
    else if (refs.posts.some((p) => p.isThumbnail)) refs.primaryType = 'post_thumbnail';
    else if (refs.messages.some((m) => m.isThumbnail)) refs.primaryType = 'message_thumbnail';
    else if (refs.announcements.length) refs.primaryType = 'announcement';
    else if (refs.newsletters.length) refs.primaryType = 'newsletter';
    else if (refs.channelUploads.length) refs.primaryType = 'channel_upload';
    else refs.primaryType = 'orphan';
  }

  return result;
}

