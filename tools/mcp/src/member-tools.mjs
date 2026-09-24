import { z } from 'zod';
import { ApiError, sanitize } from './api.mjs';

// The member connection may only read these routes, and only with GET. Every
// route is the same one the website uses, so product guards decide visibility.
const MEMBER_GET_PATHS = [
  /^auth\/me$/,
  /^posts$/,
  /^posts\/[A-Za-z0-9_-]{1,64}$/,
  /^posts\/[A-Za-z0-9_-]{1,64}\/comments$/,
  /^posts\/user\/[A-Za-z0-9_]{1,40}$/,
  /^users\/[A-Za-z0-9_]{1,40}$/,
  /^search$/,
  /^notifications$/,
  /^articles$/,
  /^articles\/[A-Za-z0-9_-]{1,64}$/,
  /^scripture$/,
];

export class MemberReadApi {
  constructor(api) {
    this.api = api;
    this.baseUrl = api.baseUrl;
  }

  async get(path, query = {}) {
    if (!MEMBER_GET_PATHS.some((pattern) => pattern.test(path)))
      throw new ApiError('This read is not available to the member connection.');
    return this.api.request(path, { query, method: 'GET' });
  }
}

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const username = z
  .string()
  .regex(/^@?[A-Za-z0-9_]{1,40}$/)
  .transform((value) => value.replace(/^@/, ''));
const limit = z.number().int().min(1).max(20).default(10);
const cursor = z.string().trim().min(1).max(200).optional();
const sort = z.enum(['new', 'trending']).default('new');

const take = (value, keys) =>
  Object.fromEntries(
    keys.filter((key) => Object.hasOwn(value ?? {}, key)).map((key) => [key, value[key]]),
  );

const GROUP_ONLY = 'This post lives in a group. Group conversations are not shared with AI connections; open it on Men of Hunger.';

export function createMemberTools({ api, webUrl = 'https://menofhunger.com', usage = async () => null }) {
  const reader = api instanceof MemberReadApi ? api : new MemberReadApi(api);
  const web = String(webUrl).replace(/\/+$/, '');
  const link = {
    post: (postId) => `${web}/p/${postId}`,
    user: (name) => (name ? `${web}/u/${name}` : null),
    article: (articleId) => `${web}/a/${articleId}`,
  };

  const author = (value) =>
    value && {
      ...take(value, ['username', 'name', 'verifiedStatus', 'premium', 'premiumPlus', 'isOrganization', 'isBot', 'authorBanned']),
      url: link.user(value.username),
    };

  const isGroupPost = (post) => Boolean(post?.communityGroupId);

  // Compact, citation-friendly post; nested posts are one level deep.
  function post(value, depth = 0) {
    if (!value || isGroupPost(value)) return null;
    const summary = {
      ...take(value, [
        'id', 'createdAt', 'editedAt', 'kind', 'body', 'visibility', 'checkinPrompt',
        'topics', 'hashtags', 'commentCount', 'boostCount', 'repostCount', 'parentId',
        'viewerCanAccess', 'authorBanned',
      ]),
      url: link.post(value.id),
      author: author(value.author),
    };
    if (Array.isArray(value.media) && value.media.length)
      summary.media = value.media.map((item) => take(item, ['kind', 'alt']));
    if (value.poll)
      summary.poll = {
        ended: value.poll.ended,
        totalVoteCount: value.poll.totalVoteCount,
        options: (value.poll.options ?? []).map((option) => take(option, ['text', 'percent', 'voteCount'])),
      };
    if (value.article) summary.article = take(value.article, ['id', 'title', 'excerpt']);
    if (depth === 0) {
      for (const key of ['parent', 'quotedPost', 'repostedPost']) {
        const nested = post(value[key], 1);
        if (nested) summary[key] = nested;
      }
    }
    return summary;
  }
  const posts = (rows) => (Array.isArray(rows) ? rows.map((row) => post(row)).filter(Boolean) : []);

  const article = (value, { includeBody = false } = {}) =>
    value && {
      ...take(value, [
        'id', 'title', 'excerpt', 'publishedAt', 'editedAt', 'visibility', 'readingTimeMinutes',
        'boostCount', 'commentCount', 'viewerCanAccess',
      ]),
      ...(includeBody && typeof value.body === 'string'
        ? { body: value.body.slice(0, 12_000), bodyTruncated: value.body.length > 12_000 }
        : {}),
      tags: (value.tags ?? []).map((tag) => tag.label ?? tag.tag).filter(Boolean),
      url: link.article(value.id),
      author: author(value.author),
    };

  const member = (value) =>
    value && {
      ...take(value, [
        'username', 'name', 'bio', 'premium', 'premiumPlus', 'verifiedStatus', 'accountKind',
        'isOrganization', 'isBot', 'createdAt', 'interests', 'locationDisplay', 'checkinStreakDays',
        'longestStreakDays', 'followerCount', 'followingCount', 'relationship', 'banned',
      ]),
      url: link.user(value.username),
    };

  // Direct messages and group activity never leave the product through this connection.
  function notification(value) {
    if (!value || value.subjectConversationId || value.subjectGroupId || value.subjectCommunityGroupInviteId) return null;
    if (value.post && isGroupPost(value.post)) return null;
    const postId = value.actorPostId ?? value.subjectPostId ?? null;
    return {
      ...take(value, ['id', 'createdAt', 'kind', 'category', 'title', 'body']),
      seen: Boolean(value.deliveredAt),
      read: Boolean(value.readAt),
      actor: value.actor ? author(value.actor) : null,
      url: postId ? link.post(postId) : value.subjectArticleId ? link.article(value.subjectArticleId) : null,
    };
  }

  const page = (result, data) => ({
    data,
    ...(result.pagination?.nextCursor !== undefined
      ? { pagination: { nextCursor: result.pagination.nextCursor ?? null } }
      : {}),
    source: result.source,
  });

  const definitions = [];
  function tool(name, description, shape, handler) {
    const schema = z.object(shape).strict();
    definitions.push({
      name,
      description,
      schema,
      localWrite: false,
      remoteWrite: false,
      execute: async (args = {}) =>
        sanitize({ environment: reader.baseUrl, ...(await handler(schema.parse(args))) }),
    });
  }

  tool('connection_status', 'Check this read-only Men of Hunger connection: who you are signed in as, your membership tier, and how many requests remain today.', {},
    async () => {
      const me = (await reader.get('auth/me')).data;
      return {
        connected: true,
        mode: 'Read-only. This connection cannot post, reply, react, follow, bookmark, or message.',
        account: take(me, ['username', 'name', 'premium', 'premiumPlus', 'verifiedStatus']),
        usage: await usage(),
      };
    });

  tool('me', 'Read your own Men of Hunger profile summary. Contact details are never included.', {},
    async () => {
      const result = await reader.get('auth/me');
      return { data: member(result.data), source: result.source };
    });

  tool('lodge_feed', 'Read recent lodge posts you can see on Men of Hunger. Use followingOnly for men you follow. Group posts are excluded.', {
    sort, followingOnly: z.boolean().default(false), kind: z.enum(['regular', 'checkin']).optional(), limit, cursor,
  }, async ({ sort, followingOnly, kind, limit, cursor }) => {
    const result = await reader.get('posts', { sort, followingOnly: followingOnly || undefined, kind, limit, cursor });
    return page(result, posts(result.data));
  });

  tool('get_post', 'Read one post by ID, with its parent and any quoted post, and a link to open it.', { postId: id },
    async ({ postId }) => {
      const result = await reader.get(`posts/${postId}`);
      if (isGroupPost(result.data)) throw new ApiError(GROUP_ONLY);
      return { data: post(result.data), source: result.source };
    });

  tool('post_replies', 'Read replies to a post in the order the website shows them. Replies inside groups are excluded.', { postId: id, limit, cursor },
    async ({ postId, limit, cursor }) => {
      const result = await reader.get(`posts/${postId}/comments`, { limit, cursor });
      return page(result, posts(result.data));
    });

  tool('member_posts', 'Read recent posts by one member, by exact username.', { username, sort, limit, cursor },
    async ({ username, sort, limit, cursor }) => {
      const result = await reader.get(`posts/user/${username}`, { sort, limit, cursor });
      return page(result, posts(result.data));
    });

  tool('member_profile', 'Read a member’s public profile by exact username: bio, interests, streak, and follow counts. Contact details are never included.', { username },
    async ({ username }) => {
      const result = await reader.get(`users/${username}`);
      return { data: member(result.data), source: result.source };
    });

  tool('search_lodge', 'Search Men of Hunger posts, members, articles, or hashtags you can see.', {
    q: z.string().trim().min(1).max(200),
    type: z.enum(['posts', 'users', 'articles', 'hashtags']).default('posts'),
    limit, cursor,
  }, async ({ q, type, limit, cursor }) => {
    const result = await reader.get('search', { q, type, limit, cursor });
    const rows = Array.isArray(result.data) ? result.data : [];
    const data = type === 'posts' ? posts(rows)
      : type === 'users' ? rows.map(member)
        : type === 'articles' ? rows.map((row) => article(row))
          : rows;
    return page(result, data);
  });

  tool('my_bookmarks', 'Read posts you have bookmarked. Reading does not change your bookmarks.', { limit, cursor },
    async ({ limit, cursor }) => {
      const result = await reader.get('search', { type: 'bookmarks', limit, cursor });
      return page(result, posts(result.data));
    });

  tool('my_notifications', 'Read your recent notifications. Reading here does not mark anything seen or read. Direct messages and group activity are excluded.', { limit, cursor },
    async ({ limit, cursor }) => {
      const result = await reader.get('notifications', { limit, cursor });
      const rows = Array.isArray(result.data) ? result.data : [];
      return {
        ...page(result, rows.map(notification).filter(Boolean)),
        unseenCount: result.pagination?.undeliveredCount ?? null,
      };
    });

  tool('articles', 'List published Men of Hunger articles you can see, optionally by author or tag.', {
    sort, authorUsername: username.optional(), tag: z.string().trim().min(1).max(60).optional(), limit, cursor,
  }, async ({ sort, authorUsername, tag, limit, cursor }) => {
    const result = await reader.get('articles', { sort, authorUsername, tag, limit, cursor });
    return page(result, (result.data ?? []).map((row) => article(row)));
  });

  tool('get_article', 'Read one article by ID, including its text when your tier can access it.', { articleId: id },
    async ({ articleId }) => {
      const result = await reader.get(`articles/${articleId}`);
      return { data: article(result.data, { includeBody: true }), source: result.source };
    });

  tool('bible_passage', 'Look up the exact text of a Bible passage by reference, such as "John 3:16" or "Romans 8:28-30".', {
    reference: z.string().trim().min(1).max(100),
  }, async ({ reference }) => {
    const result = await reader.get('scripture', { ref: reference });
    return { data: result.data, source: result.source };
  });

  return definitions;
}
