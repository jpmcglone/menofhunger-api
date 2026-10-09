import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { normalizeProfileLinkUrl, profileLinkDedupeKey, profileLinkHost } from '../../common/urls/profile-link-url';
import { AuthService } from '../auth/auth-public-api';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/redis-keys';
import { RedisService } from '../redis/redis.service';
import { PublicProfileCacheService } from './public-profile-cache.service';
import { PROFILE_LINK_SELECT, type ProfileLinkRow } from './profile-links.service';
import { UsersPublicRealtimeService } from './users-public-realtime.service';

export const MAX_PROFILE_LINKS = 10;
const VERIFIED_ONLY_MESSAGE = 'Custom links are for verified members.';

export type LegacyLinkField = 'website' | 'youtube' | 'rumble' | 'linkedin';

const LEGACY_COLUMN = {
  website: 'website',
  youtube: 'youtubeUrl',
  rumble: 'rumbleUrl',
  linkedin: 'linkedinUrl',
} as const satisfies Record<LegacyLinkField, string>;

const LEGACY_TITLE: Record<LegacyLinkField, string | null> = {
  website: null,
  youtube: 'YouTube',
  rumble: 'Rumble',
  linkedin: 'LinkedIn',
};

export const replaceLinksSchema = z
  .object({
    links: z
      .array(
        z
          .object({
            id: z.string().optional(),
            url: z.string().trim().min(1).max(500),
            title: z.string().trim().max(60).optional(),
          })
          .strict(),
      )
      .max(MAX_PROFILE_LINKS),
  })
  .strict();

export const linkSettingsSchema = z.object({ showXFollowerCount: z.boolean() }).strict();

type Tx = Pick<PrismaService, 'profileLink' | 'user'>;

/** Write side of profile links: replace-list, legacy-column shim, mirror columns, cache + realtime fan-out. */
@Injectable()
export class ProfileLinksWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: PublicProfileCacheService<{ id: string; username: string | null }>,
    private readonly publicRealtime: UsersPublicRealtimeService,
    private readonly redis: RedisService,
    private readonly auth: AuthService,
  ) {}

  /** Whole-list replace. Existing ids are updated in place, missing ones deleted, id-less ones created. */
  async replaceLinks(userId: string, body: unknown, opts: { skipVerifyGate?: boolean } = {}): Promise<void> {
    const parsed = replaceLinksSchema.parse(body);
    const owner = await this.loadOwner(userId);
    const verified = opts.skipVerifyGate === true || owner.verifiedStatus !== 'none';

    await this.prisma.$transaction(async (tx: Tx) => {
      const existing: ProfileLinkRow[] = await tx.profileLink.findMany({
        where: { userId },
        select: PROFILE_LINK_SELECT,
      });
      const byId = new Map(existing.map((r) => [r.id, r]));

      const seenIds = new Set<string>();
      const seenKeys = new Set<string>();
      const plan = parsed.links.map((item, position) => {
        const url = normalizeProfileLinkUrl(item.url);
        if (!url) throw new BadRequestException('Enter a valid public https link without credentials or secrets.');
        const key = profileLinkDedupeKey(url);
        if (seenKeys.has(key)) throw new BadRequestException('Each link can only appear once.');
        seenKeys.add(key);

        const id = item.id?.trim() || null;
        const row = id ? byId.get(id) : undefined;
        if (id) {
          if (!row) throw new BadRequestException('Unknown link id.');
          if (seenIds.has(id)) throw new BadRequestException('Each link can only appear once.');
          seenIds.add(id);
        }
        const urlChanged = row ? profileLinkDedupeKey(row.url) !== key : true;
        if (!verified && (!row || urlChanged)) throw new ForbiddenException(VERIFIED_ONLY_MESSAGE);

        const explicitTitle = item.title?.trim() || null;
        const title = explicitTitle ?? (row && !urlChanged ? row.title : profileLinkHost(url));
        return { row, url, title, position, urlChanged };
      });

      const keepIds = plan.flatMap((p) => (p.row ? [p.row.id] : []));
      await tx.profileLink.deleteMany({ where: { userId, id: { notIn: keepIds } } });

      for (const p of plan) {
        if (p.row) {
          const unchanged =
            !p.urlChanged && p.row.title === p.title && p.row.position === p.position && p.row.url === p.url;
          if (unchanged) continue;
          await tx.profileLink.update({
            where: { id: p.row.id },
            data: {
              url: p.url,
              title: p.title,
              position: p.position,
              ...(p.urlChanged ? { grandfathered: false } : {}),
            },
          });
        } else {
          await tx.profileLink.create({
            data: { userId, url: p.url, title: p.title, position: p.position, grandfathered: false },
          });
        }
      }
      await this.writeMirror(tx, userId);
    });

    await this.afterWrite(userId, owner.username, true);
  }

  /**
   * Legacy `website` / YouTube / Rumble / LinkedIn writes. Values are already normalized by the
   * caller's existing field validation; `null` removes the row. Unverified owners can only remove
   * or re-save an identical URL unless `skipVerifyGate` (admin edits).
   */
  async setLegacyFields(
    userId: string,
    fields: Partial<Record<LegacyLinkField, string | null>>,
    opts: { skipVerifyGate?: boolean; emit?: boolean } = {},
  ): Promise<void> {
    const entries = (Object.entries(fields) as Array<[LegacyLinkField, string | null | undefined]>).filter(
      ([, value]) => value !== undefined,
    );
    if (entries.length === 0) return;

    const owner = await this.loadOwner(userId);
    const verified = opts.skipVerifyGate === true || owner.verifiedStatus !== 'none';
    let changed = false;

    await this.prisma.$transaction(async (tx: Tx) => {
      for (const [field, value] of entries) {
        const current = await tx.profileLink.findFirst({
          where: { userId, legacyField: field },
          select: PROFILE_LINK_SELECT,
        });
        if (value == null || !value.trim()) {
          if (current) {
            await tx.profileLink.delete({ where: { id: current.id } });
            changed = true;
          }
          continue;
        }
        const url = normalizeProfileLinkUrl(value);
        if (!url) throw new BadRequestException('Use a public https link without credentials or secrets.');
        const key = profileLinkDedupeKey(url);
        if (current && profileLinkDedupeKey(current.url) === key) continue; // no-op
        if (!verified) throw new ForbiddenException(VERIFIED_ONLY_MESSAGE);

        const others: ProfileLinkRow[] = await tx.profileLink.findMany({
          where: { userId, ...(current ? { id: { not: current.id } } : {}) },
          select: PROFILE_LINK_SELECT,
        });
        if (others.some((r) => profileLinkDedupeKey(r.url) === key)) {
          throw new BadRequestException('That link is already on your profile.');
        }
        if (current) {
          await tx.profileLink.update({
            where: { id: current.id },
            data: { url, grandfathered: false, ...(field === 'website' ? { title: profileLinkHost(url) } : {}) },
          });
        } else {
          if (others.length >= MAX_PROFILE_LINKS) {
            throw new BadRequestException(`You can have up to ${MAX_PROFILE_LINKS} links.`);
          }
          const position = others.reduce((max, r) => Math.max(max, r.position), -1) + 1;
          await tx.profileLink.create({
            data: {
              userId,
              url,
              title: LEGACY_TITLE[field] ?? profileLinkHost(url),
              position,
              legacyField: field,
              grandfathered: false,
            },
          });
        }
        changed = true;
      }
      if (changed) await this.writeMirror(tx, userId);
    });

    if (changed) await this.afterWrite(userId, owner.username, opts.emit !== false);
  }

  async setShowXFollowerCount(userId: string, value: boolean): Promise<void> {
    const owner = await this.loadOwner(userId);
    await this.prisma.user.update({ where: { id: userId }, data: { showXFollowerCount: value } });
    await this.redisDel(owner.username);
  }

  /** Mirror each legacy User column to the URL of the row carrying that legacyField (or null). */
  private async writeMirror(tx: Tx, userId: string): Promise<void> {
    const rows: Array<{ url: string; legacyField: string | null }> = await tx.profileLink.findMany({
      where: { userId, legacyField: { not: null } },
      select: { url: true, legacyField: true },
    });
    const byField = new Map(rows.map((r) => [r.legacyField, r.url]));
    const data: Record<string, string | null> = {};
    for (const [field, column] of Object.entries(LEGACY_COLUMN)) data[column] = byField.get(field) ?? null;
    await tx.user.update({ where: { id: userId }, data });
  }

  private async loadOwner(userId: string) {
    const owner = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, verifiedStatus: true },
    });
    if (!owner) throw new NotFoundException('User not found.');
    return owner;
  }

  private async afterWrite(userId: string, username: string | null, emit: boolean): Promise<void> {
    try {
      await this.auth.bustSessionCachesForUser(userId);
      await this.cache.invalidateForUser({ id: userId, username: username ?? null });
      await this.redisDel(username);
      if (emit) await this.publicRealtime.emitPublicProfileUpdated(userId);
    } catch {
      // Best-effort: the write is committed; caches expire on their own.
    }
  }

  private async redisDel(username: string | null): Promise<void> {
    if (!username) return;
    try {
      await this.redis.del(RedisKeys.linksPage(username));
    } catch {
      // Best-effort.
    }
  }
}
