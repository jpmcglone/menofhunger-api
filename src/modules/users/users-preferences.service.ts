import { Injectable } from '@nestjs/common';
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { toUserDto } from "./user.dto";
import { PublicProfileCacheService } from "./public-profile-cache.service";
import type { PublicProfilePayload } from "./public-profiles.service";
import { UsersMeRealtimeService } from "./users-me-realtime.service";
import { UsersPublicRealtimeService } from "./users-public-realtime.service";
import { normalizeTag } from '../../common/text/normalize';

const settingsSchema = z.object({
  followVisibility: z.enum(["all", "verified", "premium", "none"]).optional(),
  birthdayVisibility: z.enum(["none", "monthDay", "full"]).optional(),
});

const articleTagPreferencesSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(50)).max(20),
});

const taxonomyPreferencesSchema = z.object({
  termIds: z.array(z.string().trim().min(1)).max(30).optional(),
  slugs: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
});

/** Viewer feed preferences and settings. */
@Injectable()
export class UsersPreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly publicProfileCache: PublicProfileCacheService<PublicProfilePayload>,
    private readonly usersMeRealtime: UsersMeRealtimeService,
    private readonly usersPublicRealtime: UsersPublicRealtimeService,
  ) {}

  async getMyArticleTagPreferences(userId: string) {
    // Legacy endpoint: read canonical taxonomy preferences first, fallback to historical rows.
    const canonical = await this.prisma.userTaxonomyPreference.findMany({
      where: { userId },
      include: { term: { select: { slug: true, label: true } } },
      orderBy: [{ createdAt: "asc" }],
    });
    if (canonical.length > 0) {
      return {
        data: canonical.map((r) => ({ tag: r.term.slug, label: r.term.label })),
      };
    }
    const legacy = await this.prisma.userArticleTagPreference.findMany({
      where: { userId },
      select: { tag: true, label: true },
      orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
    });
    return { data: legacy };
  }
  async setMyArticleTagPreferences(
    userId: string,
    body: unknown,
  ) {
    const parsed = articleTagPreferencesSchema.parse(body);
    const deduped = new Map<string, string>();
    for (const raw of parsed.tags) {
      const tag = normalizeTag(raw);
      const label = raw.trim().substring(0, 50);
      if (!tag || !label) continue;
      if (!deduped.has(tag)) deduped.set(tag, label);
    }
    const rows = [...deduped.entries()].map(([tag, label]) => ({
      userId,
      tag,
      label,
    }));

    const slugs = rows.map((r) => r.tag);
    const terms =
      slugs.length > 0
        ? await this.prisma.taxonomyTerm.findMany({
            where: { slug: { in: slugs }, status: "active" },
            select: { id: true, slug: true, label: true },
          })
        : [];
    const bySlug = new Map(terms.map((t) => [t.slug, t]));

    await this.prisma.$transaction(async (tx) => {
      await tx.userArticleTagPreference.deleteMany({ where: { userId } });
      if (rows.length > 0) {
        await tx.userArticleTagPreference.createMany({
          data: rows,
          skipDuplicates: true,
        });
      }
      await tx.userTaxonomyPreference.deleteMany({ where: { userId } });
      const prefRows = rows
        .map((r) => bySlug.get(r.tag))
        .filter(Boolean)
        .map((t) => ({ userId, termId: (t as { id: string }).id }));
      if (prefRows.length > 0) {
        await tx.userTaxonomyPreference.createMany({
          data: prefRows,
          skipDuplicates: true,
        });
      }
    });

    return {
      data: rows.map((r) => ({ tag: r.tag, label: r.label })),
    };
  }
  async getMyTaxonomyPreferences(userId: string) {
    const rows = await this.prisma.userTaxonomyPreference.findMany({
      where: { userId },
      include: {
        term: { select: { id: true, slug: true, label: true, kind: true } },
      },
      orderBy: [{ createdAt: "asc" }],
    });
    return {
      data: rows.map((r) => ({
        termId: r.term.id,
        slug: r.term.slug,
        label: r.term.label,
        kind: r.term.kind,
      })),
    };
  }
  async setMyTaxonomyPreferences(
    userId: string,
    body: unknown,
  ) {
    const parsed = taxonomyPreferencesSchema.parse(body);
    const termIds = [
      ...new Set((parsed.termIds ?? []).map((v) => v.trim()).filter(Boolean)),
    ];
    const slugs = [
      ...new Set(
        (parsed.slugs ?? []).map((v) => normalizeTag(v)).filter(Boolean),
      ),
    ];

    const terms =
      termIds.length > 0 || slugs.length > 0
        ? await this.prisma.taxonomyTerm.findMany({
            where: {
              status: "active",
              OR: [
                ...(termIds.length > 0 ? [{ id: { in: termIds } }] : []),
                ...(slugs.length > 0 ? [{ slug: { in: slugs } }] : []),
              ],
            },
            select: { id: true, slug: true, label: true, kind: true },
            take: 30,
          })
        : [];

    await this.prisma.$transaction(async (tx) => {
      await tx.userTaxonomyPreference.deleteMany({ where: { userId } });
      if (terms.length > 0) {
        await tx.userTaxonomyPreference.createMany({
          data: terms.map((t) => ({ userId, termId: t.id })),
          skipDuplicates: true,
        });
      }
      // Keep legacy table dual-written during rollout.
      await tx.userArticleTagPreference.deleteMany({ where: { userId } });
      if (terms.length > 0) {
        await tx.userArticleTagPreference.createMany({
          data: terms.map((t) => ({
            userId,
            tag: t.slug,
            label: t.label.slice(0, 50),
          })),
          skipDuplicates: true,
        });
      }
    });

    return {
      data: terms.map((t) => ({
        termId: t.id,
        slug: t.slug,
        label: t.label,
        kind: t.kind,
      })),
    };
  }
  async updateMySettings(
    body: unknown,
    userId: string,
  ) {
    const parsed = settingsSchema.parse(body);

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        followVisibility: parsed.followVisibility,
        birthdayVisibility: parsed.birthdayVisibility,
      },
    });

    await this.publicProfileCache.invalidateForUser({
      id: updated.id,
      username: updated.username ?? null,
    });
    await this.usersPublicRealtime.emitPublicProfileUpdated(updated.id);
    this.usersMeRealtime.emitMeUpdatedFromUser(updated, "settings_changed");
    return {
      data: {
        user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null),
      },
    };
  }
}
