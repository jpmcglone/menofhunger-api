import * as crypto from 'node:crypto';

function clean(s: string | null | undefined): string {
  return String(s ?? '').trim();
}

function cleanLower(s: string | null | undefined): string {
  return clean(s).toLowerCase();
}

export function stableJsonHash(value: unknown): string {
  // Stable enough for cache keys: JSON stringify with deterministic key order.
  // Avoids pulling in a dependency; supports plain objects/arrays/strings/numbers/booleans/null.
  // Note: inputs should be plain/acyclic; cycles are stringified as "[Circular]" to avoid throwing.
  const seen = new WeakSet<object>();
  const stable = (v: any): any => {
    if (v == null) return v;
    if (typeof v !== 'object') return v;
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(stable);
    const keys = Object.keys(v).sort();
    const out: Record<string, any> = {};
    for (const k of keys) out[k] = stable(v[k]);
    return out;
  };
  const json = JSON.stringify(stable(value));
  // sha256 is fast and reduces collision risk vs sha1.
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 20);
}

export const RedisKeys = {
  // Versions
  verFeedGlobal(): string {
    return 'ver:feed:global';
  },
  verSearchGlobal(): string {
    return 'ver:search:global';
  },
  verTopic(topic: string): string {
    return `ver:topic:${cleanLower(topic)}`;
  },
  verProfile(userId: string): string {
    return `ver:profile:${clean(userId)}`;
  },
  verNotifications(userId: string): string {
    return `ver:notifications:${clean(userId)}`;
  },
  verForYouUser(userId: string): string {
    return `ver:forYou:user:${clean(userId)}`;
  },

  // Session cache (tokenHash -> userId/null)
  sessionUser(tokenHash: string): string {
    return `sess:user:${clean(tokenHash)}`;
  },

  // Full session cache (tokenHash -> { user DTO, sessionId, expiresAt })
  sessionFull(tokenHash: string): string {
    return `sess:full:${clean(tokenHash)}`;
  },

  // One-time native-to-browser auth handoff (SHA-256 code hash -> short-lived payload)
  browserHandoff(codeHash: string): string {
    return `auth:browser-handoff:${clean(codeHash)}`;
  },

  // Message unread summary cache (userId -> { primary, requests })
  messageUnreadSummary(userId: string): string {
    return `msg:unread:${clean(userId)}`;
  },

  // Checkin leaderboard caches
  checkinLeaderboard(limit: number): string {
    return `checkin:leaderboard:${Math.max(1, Math.min(50, Math.floor(limit || 25)))}`;
  },
  checkinBestStreakLeaderboard(limit: number): string {
    return `checkin:leaderboard:best:${Math.max(1, Math.min(50, Math.floor(limit || 25)))}`;
  },
  checkinWeeklyLeaderboard(limit: number, weekStartIso: string): string {
    return `checkin:leaderboard:weekly:${Math.max(1, Math.min(50, Math.floor(limit || 25)))}:${clean(weekStartIso)}`;
  },

  // Public profile cache (payload is versioned internally)
  publicProfileDataByUserId(userId: string, profileVer: number): string {
    const uid = clean(userId);
    const v = Number.isFinite(profileVer) && profileVer > 0 ? Math.floor(profileVer) : 1;
    return `cache:publicProfile:id:${uid}:v${v}`;
  },
  publicProfileUsernameToId(username: string): string {
    // username is stored lowercased by callers
    return `cache:publicProfile:usernameToId:${cleanLower(username)}`;
  },

  // Anonymous read caches (versioned namespaces)
  anonPostsList(paramsHash: string, feedVer: number): string {
    return `cache:posts:list:v${feedVer}:${clean(paramsHash)}`;
  },
  authPostsList(userId: string, paramsHash: string, feedVer: number): string {
    return `cache:posts:list:user:${clean(userId)}:v${feedVer}:${clean(paramsHash)}`;
  },
  anonPostsListLock(paramsHash: string, feedVer: number): string {
    return `lock:posts:list:v${feedVer}:${clean(paramsHash)}`;
  },
  authPostsListLock(userId: string, paramsHash: string, feedVer: number): string {
    return `lock:posts:list:user:${clean(userId)}:v${feedVer}:${clean(paramsHash)}`;
  },
  notificationsList(userId: string, paramsHash: string, listVer: number): string {
    return `cache:notifications:list:user:${clean(userId)}:v${Math.max(1, Math.floor(listVer || 1))}:${clean(paramsHash)}`;
  },
  notificationsListLock(userId: string, paramsHash: string, listVer: number): string {
    return `lock:notifications:list:user:${clean(userId)}:v${Math.max(1, Math.floor(listVer || 1))}:${clean(paramsHash)}`;
  },
  forYouRankedPage1(userId: string, paramsHash: string, feedVer: number): string {
    return `cache:posts:forYou:ranked:user:${clean(userId)}:v${feedVer}:${clean(paramsHash)}`;
  },
  forYouRankedPage1Lock(userId: string, paramsHash: string, feedVer: number): string {
    return `lock:posts:forYou:ranked:user:${clean(userId)}:v${feedVer}:${clean(paramsHash)}`;
  },
  anonPostsUser(username: string, paramsHash: string, feedVer: number): string {
    return `cache:posts:user:${encodeURIComponent(cleanLower(username))}:v${feedVer}:${clean(paramsHash)}`;
  },
  anonSearch(paramsHash: string, searchVer: number): string {
    return `cache:search:v${searchVer}:${clean(paramsHash)}`;
  },
  anonExplore(feedVer: number): string {
    return `cache:explore:anon:v${feedVer}`;
  },
  anonTopics(paramsHash: string, feedVer: number): string {
    return `cache:topics:v${feedVer}:${clean(paramsHash)}`;
  },
  anonTopicPosts(topic: string, paramsHash: string, topicVer: number): string {
    return `cache:topic:${encodeURIComponent(cleanLower(topic))}:v${Math.max(1, Math.floor(topicVer || 1))}:${clean(paramsHash)}`;
  },
  anonCategoryPosts(category: string, paramsHash: string, feedVer: number): string {
    return `cache:topics:category:${encodeURIComponent(cleanLower(category))}:v${Math.max(1, Math.floor(feedVer || 1))}:${clean(paramsHash)}`;
  },
  /** Post-context discover-more candidate ids (not viewer-specific). */
  discoverMoreIds(postId: string, feedVer: number): string {
    return `cache:posts:discoverMore:${clean(postId)}:v${Math.max(1, Math.floor(feedVer || 1))}`;
  },
  /** Thread authors + mentions for composer prefill (access-checked before read). */
  threadParticipants(rootId: string): string {
    return `cache:posts:threadParticipants:${clean(rootId)}`;
  },

  /** Public marketing landing snapshot (stats + strips). */
  landingSnapshot(): string {
    return 'cache:landing:snapshot:v3';
  },

  // Throttle key for runMeChecks — set after checks run, TTL 2 min.
  // While this key is present the expensive pinned-post/streak DB checks are skipped on /auth/me.
  meChecksThrottle(userId: string): string {
    return `me:checks:throttle:${clean(userId)}`;
  },

  // /presence/online response cache — short TTL since online set changes frequently
  presenceOnlineList(viewerUserId: string | null): string {
    return `presence:online:list:${clean(viewerUserId ?? 'anon')}`;
  },

  // /bookmarks/collections response cache per user
  bookmarksCollections(userId: string): string {
    return `bookmarks:collections:${clean(userId)}`;
  },

  // /checkins/today state cache per user per day
  checkinTodayState(userId: string, dayKey: string): string {
    return `checkin:today:${clean(userId)}:${clean(dayKey)}`;
  },

  // /groups/featured response cache (per viewer; invalidated on feature/unfeature changes)
  groupsFeatured(viewerUserId: string): string {
    return `groups:featured:${clean(viewerUserId)}`;
  },

  // /hashtags/trending response cache (per visibility set)
  hashtagsTrending(paramsHash: string): string {
    return `hashtags:trending:${clean(paramsHash)}`;
  },

  // Checkin leaderboard viewer rank cache (per viewer per limit per scope)
  checkinLeaderboardViewerRank(userId: string, limit: number, scope?: string): string {
    const scopeSuffix = scope && scope !== 'active' ? `:${clean(scope)}` : '';
    return `checkin:leaderboard:rank:${clean(userId)}:${Math.max(1, Math.min(50, Math.floor(limit || 25)))}${scopeSuffix}`;
  },

  // Viewer block sets cache (rarely changes; invalidated on block/unblock)
  viewerBlockSets(userId: string): string {
    return `viewer:blocks:${clean(userId)}`;
  },

  // Presence
  presenceSocket(instanceId: string, socketId: string): string {
    return `presence:socket:${clean(instanceId)}:${clean(socketId)}`;
  },
  presenceUserSockets(userId: string): string {
    return `presence:user:${clean(userId)}:sockets`;
  },
  presenceOnlineZset(): string {
    return 'presence:online';
  },
  presenceAnonOnlineZset(): string {
    return 'presence:anon:online';
  },
  presenceAnonSockets(anonId: string): string {
    return `presence:anon:${clean(anonId)}:sockets`;
  },
  presenceIdleSet(): string {
    return 'presence:idle';
  },
  presencePubSubChannel(): string {
    return 'presence:events';
  },

  // External caches
  webstersWotd(dayKey: string, includeDefinition: boolean): string {
    return `daily:websters:wotd:${clean(dayKey)}:${includeDefinition ? 'def' : 'nodef'}`;
  },
  giphyTrending(limit: number): string {
    return `giphy:trending:${Math.max(1, Math.min(50, Math.floor(limit || 24)))}`;
  },
  giphySearch(q: string, limit: number): string {
    const qn = cleanLower(q).slice(0, 120);
    const lim = Math.max(1, Math.min(50, Math.floor(limit || 24)));
    const qh = crypto.createHash('sha1').update(qn).digest('hex').slice(0, 12);
    return `giphy:search:${qh}:${lim}`;
  },
  geoUs(query: string): string {
    const qn = cleanLower(query).slice(0, 200);
    const h = crypto.createHash('sha1').update(qn).digest('hex').slice(0, 20);
    return `geo:us:${h}`;
  },
  linkMeta(url: string): string {
    const u = clean(url);
    const h = crypto.createHash('sha1').update(u).digest('hex').slice(0, 20);
    return `linkmeta:${h}`;
  },
  linkMetaLock(url: string): string {
    const u = clean(url);
    const h = crypto.createHash('sha1').update(u).digest('hex').slice(0, 20);
    return `lock:linkmeta:${h}`;
  },

  // Email quota budget (daily team counter + per-user engagement cap)
  /** Transactional email send count for a UTC date (e.g. "2026-08-04"). TTL 48h. */
  emailDailyCount(dateKey: string): string {
    return `email:daily:count:${clean(dateKey)}`;
  },
  /** Last engagement email timestamp for a user. Exists while the 24h cap is active. TTL 24h+. */
  emailLastEngagement(userId: string): string {
    return `email:eng:last:${clean(userId)}`;
  },
  /** Admin newsletter / broadcast send count for a UTC date. TTL 48h. */
  emailBroadcastDailyCount(dateKey: string): string {
    return `email:broadcast:count:${clean(dateKey)}`;
  },

  /** scripture:{translation}:{bookId}:{chapter} — immutable verse text, 30-day TTL. */
  scriptureChapter(translation: string, bookId: string, chapter: number): string {
    return `scripture:${clean(translation)}:${clean(bookId)}:${chapter}`;
  },

  // Push delivery caches
  /** Actor mini-profile (avatarKey, username, name) for APNs rich content. */
  pushActorMini(userId: string): string {
    return `push:actor:mini:${clean(userId)}`;
  },
  /** Notification preferences for a recipient. Invalidated on updatePreferences. */
  pushPrefs(userId: string): string {
    return `push:prefs:${clean(userId)}`;
  },
  /** APNs device tokens for a user. Invalidated on register/unregister/prune. */
  pushApnsTokens(userId: string): string {
    return `push:apns:tokens:${clean(userId)}`;
  },
  /** Debounce window for badge-only APNs sync (SET NX). */
  badgeSyncDebounce(userId: string): string {
    return `badge-sync:${clean(userId)}`;
  },
  /** Last badge value successfully sent via badge-only APNs. */
  badgeSyncLastSent(userId: string): string {
    return `badge-sync:last:${clean(userId)}`;
  },

  // Spaces lobby counts — global snapshot (updated on every join/leave)
  spacesLobbyCounts(): string {
    return 'spaces:lobbyCounts';
  },
  /** Per-instance local lobby counts (hash: spaceId → count). TTL'd so crashed instances expire. */
  spacesLobbyCountsInstance(instanceId: string): string {
    return `spaces:lobbyCounts:inst:${clean(instanceId)}`;
  },
  /** Set of instance ids that recently published lobby counts. */
  spacesLobbyCountsInstances(): string {
    return 'spaces:lobbyCounts:instances';
  },
  /** Epoch ms when a space lobby last became empty (shared across instances). */
  spacesEmptySince(spaceId: string): string {
    return `spaces:emptySince:${clean(spaceId)}`;
  },

  // Watch Party — ephemeral playback state, survives server restarts via Redis
  watchPartyState(spaceId: string): string {
    return `wp:state:${clean(spaceId)}`;
  },
} as const;
