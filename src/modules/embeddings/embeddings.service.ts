import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import OpenAI from 'openai';
import { TOPIC_OPTIONS } from '../../common/topics/topic-options';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';

export type EmbeddingKind = 'post' | 'group' | 'user';

const MIN_POST_CHARS = 24;
const MAX_TEXT_CHARS = 2_000;
const QUERY_CACHE_MAX = 500;
const QUERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 8_000;
const BATCH_SIZE = 64;
/** Rough token estimate when the API does not report usage. */
const CHARS_PER_TOKEN = 4;

const TOPIC_LABELS = new Map(TOPIC_OPTIONS.map((o) => [o.value, o.label] as const));

export type NearestRow = { id: string; distance: number };

type Candidate = { id: string; text: string };

/**
 * Semantic vectors for posts, groups, and members (pgvector).
 *
 * Context rule: a vector is derived only from text its audience can already read. Group
 * posts are embedded, but every query must apply the same readability filter as ordinary
 * search (pass it as `where`), so a vector never surfaces content its viewer cannot see.
 *
 * Every method is fail-soft: unconfigured, over budget, or failing calls return null and
 * callers keep their previous behavior. Content is embedded once per text hash, and a
 * daily dollar cap bounds spend per API process.
 */
@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);
  private client: OpenAI | null = null;
  private spend = { day: '', tokens: 0 };
  private warnedDay = '';
  private readonly queryCache = new Map<string, { at: number; vector: number[] }>();

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
  ) {}

  available(): boolean {
    return this.config.embeddings().enabled && !this.overBudget();
  }

  health() {
    const cfg = this.config.embeddings();
    return {
      configured: cfg.enabled,
      model: cfg.model,
      spentTodayUsd: this.spentUsd(),
      dailyBudgetUsd: cfg.dailyBudgetUsd,
      budgetExhausted: cfg.enabled && this.overBudget(),
    };
  }

  /** Embeds one short text, such as a search query or a free-text intent. Cached for a day. */
  async embedQuery(text: string): Promise<number[] | null> {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (clean.length < 2 || !this.available()) return null;
    const key = clean.toLowerCase();
    const hit = this.queryCache.get(key);
    if (hit && Date.now() - hit.at < QUERY_CACHE_TTL_MS) return hit.vector;
    const [vector] = (await this.embedMany([clean])) ?? [];
    if (!vector) return null;
    if (this.queryCache.size >= QUERY_CACHE_MAX) {
      const oldest = this.queryCache.keys().next().value;
      if (oldest !== undefined) this.queryCache.delete(oldest);
    }
    this.queryCache.set(key, { at: Date.now(), vector });
    return vector;
  }

  async embedMany(texts: string[]): Promise<number[][] | null> {
    const cfg = this.config.embeddings();
    if (!cfg.enabled || texts.length === 0 || this.overBudget()) return null;
    try {
      const client = (this.client ??= new OpenAI({ apiKey: cfg.apiKey, timeout: TIMEOUT_MS, maxRetries: 1 }));
      const result = await client.embeddings.create({
        model: cfg.model,
        input: texts,
        dimensions: cfg.dimensions,
      });
      const tokens = result.usage?.total_tokens ?? Math.ceil(texts.join(' ').length / CHARS_PER_TOKEN);
      this.recordTokens(tokens);
      const ordered = [...result.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      return ordered.length === texts.length ? ordered : null;
    } catch (err) {
      this.logger.warn(`[embeddings] failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // ── Indexing ────────────────────────────────────────────────────────────────

  async indexPost(postId: string): Promise<void> {
    const candidate = await this.postCandidate(postId);
    if (!candidate) {
      await this.prisma.$executeRaw`DELETE FROM "PostEmbedding" WHERE "postId" = ${postId}`;
      return;
    }
    await this.store('post', [candidate]);
  }

  async indexGroup(groupId: string): Promise<void> {
    const candidate = await this.groupCandidate(groupId);
    if (!candidate) {
      await this.prisma.$executeRaw`DELETE FROM "GroupEmbedding" WHERE "groupId" = ${groupId}`;
      return;
    }
    await this.store('group', [candidate]);
  }

  async indexUser(userId: string): Promise<void> {
    const candidate = await this.userCandidate(userId);
    if (!candidate) {
      await this.prisma.$executeRaw`DELETE FROM "UserEmbedding" WHERE "userId" = ${userId}`;
      return;
    }
    await this.store('user', [candidate]);
  }

  /** Embeds a bounded batch of content that has no vector yet. Safe to run repeatedly. */
  async backfill(limit = BATCH_SIZE): Promise<{ posts: number; groups: number; users: number }> {
    const out = { posts: 0, groups: 0, users: 0 };
    if (!this.available()) return out;
    const take = Math.max(1, Math.min(BATCH_SIZE, limit));

    const posts = await this.prisma.$queryRaw<Array<{ id: string; body: string | null; hashtags: string[] }>>`
      SELECT p."id", p."body", p."hashtags"
      FROM "Post" p
      LEFT JOIN "PostEmbedding" e ON e."postId" = p."id"
      WHERE e."postId" IS NULL
        AND p."deletedAt" IS NULL AND p."isDraft" = false AND p."kind" <> 'repost'
        AND p."visibility" <> 'onlyMe'
        AND length(btrim(COALESCE(p."body", ''))) >= ${MIN_POST_CHARS}
      ORDER BY p."createdAt" DESC
      LIMIT ${take}`;
    out.posts = await this.store('post', posts.map((p) => ({ id: p.id, text: postText(p.body, p.hashtags) })));

    const groups = await this.prisma.$queryRaw<Array<{ id: string; name: string; description: string }>>`
      SELECT g."id", g."name", g."description"
      FROM "CommunityGroup" g
      LEFT JOIN "GroupEmbedding" e ON e."groupId" = g."id"
      WHERE e."groupId" IS NULL AND g."deletedAt" IS NULL AND g."joinPolicy" = 'open'
      LIMIT ${take}`;
    out.groups = await this.store('group', groups.map((g) => ({ id: g.id, text: groupText(g.name, g.description) })));

    const users = await this.prisma.$queryRaw<Array<{ id: string; bio: string | null; interests: string[] }>>`
      SELECT u."id", u."bio", u."interests"
      FROM "User" u
      LEFT JOIN "UserEmbedding" e ON e."userId" = u."id"
      WHERE e."userId" IS NULL AND ${eligibleUserSql()}
        AND (length(btrim(COALESCE(u."bio", ''))) >= 8 OR cardinality(u."interests") > 0)
      LIMIT ${take}`;
    out.users = await this.store('user', users.map((u) => ({ id: u.id, text: userText(u.bio, u.interests) })));

    if (out.posts + out.groups + out.users > 0) {
      this.logger.log(`[embeddings] indexed posts=${out.posts} groups=${out.groups} users=${out.users}`);
    }
    return out;
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  /**
   * Nearest posts by cosine distance. `where` must carry the viewer's visibility and
   * group-readability filters, written against the aliases `p` (Post).
   */
  async nearestPosts(
    vector: number[],
    opts: { limit: number; maxDistance: number; where: Prisma.Sql },
  ): Promise<NearestRow[]> {
    const v = vectorLiteral(vector);
    const rows = await this.prisma.$queryRaw<Array<{ id: string; distance: number }>>(Prisma.sql`
      SELECT p."id" AS "id", (e."embedding" <=> ${v}::vector)::float8 AS "distance"
      FROM "PostEmbedding" e
      JOIN "Post" p ON p."id" = e."postId"
      WHERE p."deletedAt" IS NULL AND p."isDraft" = false ${opts.where}
        AND (e."embedding" <=> ${v}::vector) <= ${opts.maxDistance}
      ORDER BY e."embedding" <=> ${v}::vector
      LIMIT ${opts.limit}`);
    return rows;
  }

  async nearestGroups(
    vector: number[],
    opts: { limit: number; maxDistance: number; excludeGroupIds?: string[] },
  ): Promise<NearestRow[]> {
    const v = vectorLiteral(vector);
    const exclude = opts.excludeGroupIds?.length
      ? Prisma.sql`AND g."id" NOT IN (${Prisma.join(opts.excludeGroupIds)})`
      : Prisma.empty;
    return this.prisma.$queryRaw<Array<{ id: string; distance: number }>>(Prisma.sql`
      SELECT g."id" AS "id", (e."embedding" <=> ${v}::vector)::float8 AS "distance"
      FROM "GroupEmbedding" e
      JOIN "CommunityGroup" g ON g."id" = e."groupId"
      WHERE g."deletedAt" IS NULL AND g."joinPolicy" = 'open' ${exclude}
        AND (e."embedding" <=> ${v}::vector) <= ${opts.maxDistance}
      ORDER BY e."embedding" <=> ${v}::vector
      LIMIT ${opts.limit}`);
  }

  async nearestUsers(
    vector: number[],
    opts: { limit: number; maxDistance: number; excludeUserIds?: string[] },
  ): Promise<NearestRow[]> {
    const v = vectorLiteral(vector);
    const exclude = opts.excludeUserIds?.length
      ? Prisma.sql`AND u."id" NOT IN (${Prisma.join(opts.excludeUserIds)})`
      : Prisma.empty;
    return this.prisma.$queryRaw<Array<{ id: string; distance: number }>>(Prisma.sql`
      SELECT u."id" AS "id", (e."embedding" <=> ${v}::vector)::float8 AS "distance"
      FROM "UserEmbedding" e
      JOIN "User" u ON u."id" = e."userId"
      WHERE ${eligibleUserSql()} ${exclude}
        AND (e."embedding" <=> ${v}::vector) <= ${opts.maxDistance}
      ORDER BY e."embedding" <=> ${v}::vector
      LIMIT ${opts.limit}`);
  }

  /** Vector already stored for a post, for "more like this". Null when not indexed yet. */
  async storedPostVector(postId: string): Promise<number[] | null> {
    const rows = await this.prisma.$queryRaw<Array<{ v: string }>>`
      SELECT "embedding"::text AS v FROM "PostEmbedding" WHERE "postId" = ${postId}`;
    return rows[0] ? parseVector(rows[0].v) : null;
  }

  async storedUserVector(userId: string): Promise<number[] | null> {
    const rows = await this.prisma.$queryRaw<Array<{ v: string }>>`
      SELECT "embedding"::text AS v FROM "UserEmbedding" WHERE "userId" = ${userId}`;
    return rows[0] ? parseVector(rows[0].v) : null;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async store(kind: EmbeddingKind, candidates: Candidate[]): Promise<number> {
    if (candidates.length === 0) return 0;
    const cfg = this.config.embeddings();
    const hashed = candidates.map((c) => ({ ...c, hash: hashText(c.text) }));
    const existing = await this.existingHashes(kind, hashed.map((c) => c.id));
    const todo = hashed.filter((c) => existing.get(c.id) !== c.hash && c.text.trim().length > 0);
    if (todo.length === 0) return 0;
    const vectors = await this.embedMany(todo.map((c) => c.text.slice(0, MAX_TEXT_CHARS)));
    if (!vectors) return 0;
    for (let i = 0; i < todo.length; i++) {
      const c = todo[i]!;
      const v = vectorLiteral(vectors[i]!);
      if (kind === 'post') {
        await this.prisma.$executeRaw`
          INSERT INTO "PostEmbedding" ("postId", "model", "contentHash", "embedding", "updatedAt")
          VALUES (${c.id}, ${cfg.model}, ${c.hash}, ${v}::vector, NOW())
          ON CONFLICT ("postId") DO UPDATE SET "model" = EXCLUDED."model", "contentHash" = EXCLUDED."contentHash",
            "embedding" = EXCLUDED."embedding", "updatedAt" = NOW()`;
      } else if (kind === 'group') {
        await this.prisma.$executeRaw`
          INSERT INTO "GroupEmbedding" ("groupId", "model", "contentHash", "embedding", "updatedAt")
          VALUES (${c.id}, ${cfg.model}, ${c.hash}, ${v}::vector, NOW())
          ON CONFLICT ("groupId") DO UPDATE SET "model" = EXCLUDED."model", "contentHash" = EXCLUDED."contentHash",
            "embedding" = EXCLUDED."embedding", "updatedAt" = NOW()`;
      } else {
        await this.prisma.$executeRaw`
          INSERT INTO "UserEmbedding" ("userId", "model", "contentHash", "embedding", "updatedAt")
          VALUES (${c.id}, ${cfg.model}, ${c.hash}, ${v}::vector, NOW())
          ON CONFLICT ("userId") DO UPDATE SET "model" = EXCLUDED."model", "contentHash" = EXCLUDED."contentHash",
            "embedding" = EXCLUDED."embedding", "updatedAt" = NOW()`;
      }
    }
    return todo.length;
  }

  private async existingHashes(kind: EmbeddingKind, ids: string[]): Promise<Map<string, string>> {
    const list = Prisma.join(ids);
    const rows =
      kind === 'post'
        ? await this.prisma.$queryRaw<Array<{ id: string; h: string }>>(Prisma.sql`SELECT "postId" AS id, "contentHash" AS h FROM "PostEmbedding" WHERE "postId" IN (${list})`)
        : kind === 'group'
          ? await this.prisma.$queryRaw<Array<{ id: string; h: string }>>(Prisma.sql`SELECT "groupId" AS id, "contentHash" AS h FROM "GroupEmbedding" WHERE "groupId" IN (${list})`)
          : await this.prisma.$queryRaw<Array<{ id: string; h: string }>>(Prisma.sql`SELECT "userId" AS id, "contentHash" AS h FROM "UserEmbedding" WHERE "userId" IN (${list})`);
    return new Map(rows.map((r) => [r.id, r.h] as const));
  }

  private async postCandidate(postId: string): Promise<Candidate | null> {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, deletedAt: null, isDraft: false, kind: { not: 'repost' }, visibility: { not: 'onlyMe' } },
      select: { id: true, body: true, hashtags: true },
    });
    if (!post || (post.body ?? '').trim().length < MIN_POST_CHARS) return null;
    return { id: post.id, text: postText(post.body, post.hashtags) };
  }

  private async groupCandidate(groupId: string): Promise<Candidate | null> {
    const group = await this.prisma.communityGroup.findFirst({
      where: { id: groupId, deletedAt: null, joinPolicy: 'open' },
      select: { id: true, name: true, description: true },
    });
    return group ? { id: group.id, text: groupText(group.name, group.description) } : null;
  }

  private async userCandidate(userId: string): Promise<Candidate | null> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; bio: string | null; interests: string[] }>>(Prisma.sql`
      SELECT u."id", u."bio", u."interests" FROM "User" u
      WHERE u."id" = ${userId} AND ${eligibleUserSql()}`);
    const user = rows[0];
    if (!user) return null;
    const text = userText(user.bio, user.interests);
    return text ? { id: user.id, text } : null;
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private spentTokens(): number {
    return this.spend.day === this.today() ? this.spend.tokens : 0;
  }

  private spentUsd(): number {
    return (this.spentTokens() / 1_000_000) * this.config.embeddings().usdPerMillionTokens;
  }

  private recordTokens(tokens: number) {
    const day = this.today();
    if (this.spend.day !== day) this.spend = { day, tokens: 0 };
    this.spend.tokens += Math.max(0, Math.floor(tokens));
  }

  private overBudget(): boolean {
    const cfg = this.config.embeddings();
    if (this.spentUsd() < cfg.dailyBudgetUsd) return false;
    const day = this.today();
    if (this.warnedDay !== day) {
      this.warnedDay = day;
      this.logger.warn(`[embeddings] daily budget of $${cfg.dailyBudgetUsd} reached; paused until tomorrow (UTC)`);
    }
    return true;
  }
}

function eligibleUserSql(): Prisma.Sql {
  return Prisma.sql`u."accountKind" = 'person' AND u."usernameIsSet" = true AND u."isBot" = false
    AND u."bannedAt" IS NULL AND u."deletionRequestedAt" IS NULL`;
}

export function postText(body: string | null, hashtags: string[] | null): string {
  const tags = (hashtags ?? []).slice(0, 8).map((t) => `#${t}`).join(' ');
  return [(body ?? '').trim(), tags].filter(Boolean).join('\n').slice(0, MAX_TEXT_CHARS);
}

export function groupText(name: string, description: string): string {
  return `${name.trim()}. ${description.trim()}`.slice(0, MAX_TEXT_CHARS);
}

export function userText(bio: string | null, interests: string[] | null): string {
  const topics = (interests ?? []).map((v) => TOPIC_LABELS.get(v) ?? v).slice(0, 20);
  return [(bio ?? '').trim(), topics.length ? `Interests: ${topics.join(', ')}` : ''].filter(Boolean).join('\n').slice(0, MAX_TEXT_CHARS);
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function vectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

export function parseVector(raw: string): number[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((n) => typeof n === 'number') ? parsed : null;
  } catch {
    return null;
  }
}
