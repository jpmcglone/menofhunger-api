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

  // Session cache (tokenHash -> userId/null)
  sessionUser(tokenHash: string): string {
    return `sess:user:${clean(tokenHash)}`;
  },

  // Full session cache (tokenHash -> { user DTO, sessionId, expiresAt })
  sessionFull(tokenHash: string): string {
    return `sess:full:${clean(tokenHash)}`;
  },

  // Message unread summary cache (userId -> { primary, requests })
  messageUnreadSummary(userId: string): string {
    return `msg:unread:${clean(userId)}`;
  },

  // Checkin leaderboard caches
  checkinLeaderboard(limit: number): string {
    return `checkin:leaderboard:${Math.max(1, Math.min(50, Math.floor(limit || 25)))}`;
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
  anonPostsUser(username: string, paramsHash: string, feedVer: number): string {
    return `cache:posts:user:${encodeURIComponent(cleanLower(username))}:v${feedVer}:${clean(paramsHash)}`;
  },
  anonSearch(paramsHash: string, searchVer: number): string {
    return `cache:search:v${searchVer}:${clean(paramsHash)}`;
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

  // Spaces lobby counts — global snapshot (updated on every join/leave)
  spacesLobbyCounts(): string {
    return 'spaces:lobbyCounts';
  },

  // Watch Party — ephemeral playback state, survives server restarts via Redis
  watchPartyState(spaceId: string): string {
    return `wp:state:${clean(spaceId)}`;
  },
} as const;

