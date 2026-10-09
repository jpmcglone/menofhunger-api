import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { isUniqueViolation, isNotFound } from '../../common/prisma/errors';
import { ORG_AFFILIATION_SELECT, USER_REF_SELECT } from "../../common/prisma-selects/user.select";
import { revokeAccountChannels, emitChannelAccessChange } from "../group-channels/channel-lifecycle";
import { publicPreviewUrl } from "../../common/urls/public-preview-url";
import { normalizeSocialProfileUrl } from "../../common/urls/social-profile-url";
import { Injectable, BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { normalizePhone } from "../auth/auth-public-api";
import { AppConfigService } from "../app/app-config.service";
import { groupOrgAffiliations, toUserDto, type OrgAffiliationDto } from "../../common/dto";
import { PrismaService } from "../prisma/prisma.service";
import { validateUsername } from "../users/users.utils";
import { PublicProfileCacheService } from "../users/public-profile-cache.service";
import type { AdminRequest } from "./admin.guard";
import { UsersMeRealtimeService } from "../users/users-me-realtime.service";
import { UsersPublicRealtimeService } from "../users/users-public-realtime.service";
import { AuthService } from "../auth/auth-public-api";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { SlackService } from "../../common/slack/slack.service";
import { EntitlementService } from "../billing/entitlement.service";
import { BillingService } from "../billing/billing.service";
import { sanitizeFeatureToggles } from "../../common/feature-toggles";
import { CoinsService } from "../coins/coins.service";
import { UsersLocationService } from "../users/users-location.service";
import { UploadsService } from "../uploads/uploads.service";
import { UserVerificationService } from "../verification/user-verification.service";
import { findUserByUsernameOrThrow } from "./admin-users.lookup";
import { PagesService } from "../pages/pages.service";
import { ProfileLinksWriteService, type LegacyLinkField } from "../users/profile-links-write.service";
import { PostsReadService } from "../posts-read/posts-read.service";
import { paginatedSearchSchema, adminUsernameSchema, banSchema, updateUserSchema, adjustCoinsSchema, usernameParamSchema } from "./admin-users.constants";
import { toPage } from "../../common/pagination/page";

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly publicProfileCache: PublicProfileCacheService<{
      id: string;
      username: string | null;
    }>,
    private readonly usersMeRealtime: UsersMeRealtimeService,
    private readonly usersPublicRealtime: UsersPublicRealtimeService,
    private readonly auth: AuthService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly slack: SlackService,
    private readonly entitlementService: EntitlementService,
    private readonly billingService: BillingService,
    private readonly coinsService: CoinsService,
    private readonly usersLocation: UsersLocationService,
    private readonly uploads: UploadsService,
    private readonly userVerification: UserVerificationService,
    private readonly pages: PagesService,
    private readonly postsRead: PostsReadService,
    private readonly profileLinks: ProfileLinksWriteService,
  ) {}

  private get publicBaseUrl(): string | null {
    return this.appConfig.r2()?.publicBaseUrl ?? null;
  }

  /** Single-user admin DTO with org affiliations included. */
  private async toAdminUserDto(user: Parameters<typeof toUserDto>[0]) {
    const orgMap = await this.batchOrgAffiliations([user.id]);
    return {
      ...toUserDto(user, this.publicBaseUrl),
      orgAffiliations: orgMap.get(user.id) ?? [],
    };
  }

  private maskPhone(phone: string | null): string {
    const trimmed = (phone ?? "").trim();
    if (!trimmed) return "";
    const visible = trimmed.slice(-2);
    const maskedLen = Math.max(0, trimmed.length - visible.length);
    return `${"*".repeat(maskedLen)}${visible}`;
  }

  private maskEmail(email: string | null): string | null {
    const raw = (email ?? "").trim();
    if (!raw) return null;
    const [local, domain] = raw.split("@");
    if (!local || !domain) return "***";
    const localVisible = local.slice(0, 1);
    return `${localVisible}${"*".repeat(Math.max(1, local.length - 1))}@${domain}`;
  }

  private maskBirthdate(iso: string | null): string | null {
    const raw = (iso ?? "").trim();
    if (!raw) return null;
    return "****-**-**";
  }

  /** Slice a take+1 user list into a paginated response with org affiliations. */
  private async paginatedUserResult(
    users: Parameters<typeof toUserDto>[0][],
    take: number,
  ) {
    const { items: slice, nextCursor } = toPage(users, take, (r) => r.id);
    const orgMap = await this.batchOrgAffiliations(slice.map((u) => u.id));
    return {
      data: slice.map((u) => ({
        ...toUserDto(u, this.publicBaseUrl),
        orgAffiliations: orgMap.get(u.id) ?? [],
      })),
      pagination: { nextCursor },
    };
  }

  /** Batch-fetch org affiliations. Returns map of userId → OrgAffiliationDto[]. */
  private async batchOrgAffiliations(
    userIds: string[],
  ): Promise<Map<string, OrgAffiliationDto[]>> {
    if (userIds.length === 0) return new Map();
    const publicBaseUrl = this.publicBaseUrl;
    const memberships = await this.prisma.userOrgMembership.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        org: {
          select: ORG_AFFILIATION_SELECT,
        },
      },
      orderBy: { createdAt: "asc" },
    });
    return groupOrgAffiliations(memberships, publicBaseUrl);
  }
  async listBanned(query: unknown) {
    const { q, limit, cursor } = paginatedSearchSchema.parse(query);
    const take = limit ?? 25;

    const raw = (q ?? "").trim();
    const cleaned = raw.startsWith("@") ? raw.slice(1) : raw;

    const where: Prisma.UserWhereInput = {
      bannedAt: { not: null },
      ...(cleaned
        ? {
            OR: [
              { username: { contains: cleaned, mode: "insensitive" } },
              { name: { contains: cleaned, mode: "insensitive" } },
              { email: { contains: cleaned, mode: "insensitive" } },
              { phone: { contains: cleaned } },
            ],
          }
        : {}),
    };

    const users = await this.prisma.user.findMany({
      where,
      orderBy: [{ bannedAt: "desc" }, { id: "desc" }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    return this.paginatedUserResult(users, take);
  }
  async search(query: unknown) {
    const { q, limit, cursor } = paginatedSearchSchema.parse(query);
    const take = limit ?? 20;

    const raw = (q ?? "").trim();
    const cleaned = raw.startsWith("@") ? raw.slice(1) : raw;
    const words = cleaned
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 2);

    let where: Prisma.UserWhereInput | undefined;
    if (cleaned) {
      const orConditions: Prisma.UserWhereInput[] = [
        { username: { contains: cleaned, mode: "insensitive" } },
        { name: { contains: cleaned, mode: "insensitive" } },
        { email: { contains: cleaned, mode: "insensitive" } },
        { phone: { contains: cleaned } },
      ];
      // Each individual word (catches partial first/last name searches like "chris" or "grif").
      for (const w of words) {
        if (w === cleaned.toLowerCase()) continue;
        orConditions.push({ username: { contains: w, mode: "insensitive" } });
        orConditions.push({ name: { contains: w, mode: "insensitive" } });
        orConditions.push({ email: { contains: w, mode: "insensitive" } });
      }
      // All words must appear in the same field — catches word-order-independent queries
      // like "Griffith Chris" or "Chris G" matching "Chris Griffith".
      if (words.length >= 2) {
        orConditions.push({
          AND: words.map((w) => ({
            name: { contains: w, mode: "insensitive" as const },
          })),
        });
        orConditions.push({
          AND: words.map((w) => ({
            username: { contains: w, mode: "insensitive" as const },
          })),
        });
        orConditions.push({
          AND: words.map((w) => ({
            email: { contains: w, mode: "insensitive" as const },
          })),
        });
      }
      where = { OR: orConditions };
    }

    const users = await this.prisma.user.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    return this.paginatedUserResult(users, take);
  }
  async usernameAvailable(query: unknown) {
    const { username } = adminUsernameSchema.parse(query);
    const parsed = validateUsername(username ?? "", {
      minLen: 2,
      allowReserved: true,
    });
    if (!parsed.ok)
      return {
        data: { available: false, normalized: null, error: parsed.error },
      };

    const exists =
      (
        await this.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "User"
          WHERE LOWER("username") = LOWER(${parsed.username})
          LIMIT 1
        `
      )[0] ?? null;

    return { data: { available: !exists, normalized: parsed.usernameLower } };
  }
  async ban(req: AdminRequest, id: string, body: unknown) {
    const { reason } = banSchema.parse(body);
    const adminId = String(req.user?.id ?? "").trim();
    if (!adminId) throw new NotFoundException();

    const current = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, siteAdmin: true, username: true },
    });
    if (!current) throw new NotFoundException("User not found.");
    if (current.siteAdmin)
      throw new BadRequestException("Site admins cannot be banned.");

    const now = new Date();
    const { updated, channelGroups } = await this.prisma.$transaction(
      async (tx) => {
        const channelGroups = await revokeAccountChannels(tx, id);
        const user = await tx.user.update({
          where: { id },
          data: {
            bannedAt: now,
            bannedReason: (reason ?? "").trim() || null,
            bannedByAdminId: adminId,
          },
        });
        return { updated: user, channelGroups };
      },
    );
    for (const groupId of channelGroups)
      await emitChannelAccessChange(
        this.prisma,
        this.presenceRealtime,
        groupId,
        id,
      );

    // Revoke all active sessions immediately.
    await this.auth.revokeAllSessionsForUser(updated.id);

    // Best-effort: notify active clients first, then disconnect sockets.
    try {
      this.usersMeRealtime.emitMeUpdatedFromUser(updated, "account_banned");
    } catch {
      // Best-effort
    }
    try {
      this.presenceRealtime.disconnectUserSockets(updated.id);
    } catch {
      // Best-effort
    }

    // Invalidate public profile cache (in case they were visible in search, etc).
    try {
      await this.publicProfileCache.invalidateForUser({
        id: updated.id,
        username: updated.username ?? null,
      });
    } catch {
      // Best-effort
    }

    return { data: await this.toAdminUserDto(updated) };
  }
  async unban(id: string) {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("User not found.");

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...NOT_BANNED_USER_WHERE,
        bannedReason: null,
        bannedByAdminId: null,
      },
    });

    try {
      await this.publicProfileCache.invalidateForUser({
        id: updated.id,
        username: updated.username ?? null,
      });
    } catch {
      // Best-effort
    }

    // Realtime: refresh their own auth snapshot across devices if they are logged in again later.
    try {
      this.usersMeRealtime.emitMeUpdatedFromUser(updated, "admin_user_updated");
      await this.usersPublicRealtime.emitPublicProfileUpdated(updated.id);
    } catch {
      // Best-effort
    }

    return { data: await this.toAdminUserDto(updated) };
  }
  async getUser(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException("User not found.");
    return { data: await this.toAdminUserDto(user) };
  }
  async getUserByUsername(params: unknown) {
    const { username } = usernameParamSchema.parse(params);
    const user = await findUserByUsernameOrThrow(this.prisma, username);
    const full = await this.toAdminUserDto(user);

    return {
      data: {
        ...full,
        sensitive: {
          phone: this.maskPhone(full.phone),
          email: this.maskEmail(full.email),
          birthdate: this.maskBirthdate(full.birthdate),
        },
        canRevealSensitive: true,
      },
    };
  }
  async revealSensitiveByUsername(params: unknown) {
    const { username } = usernameParamSchema.parse(params);
    const user = await findUserByUsernameOrThrow(this.prisma, username);
    const dto = toUserDto(user, this.publicBaseUrl);
    return {
      data: {
        phone: dto.phone,
        email: dto.email,
        birthdate: dto.birthdate,
      },
    };
  }
  async updateUser(id: string, body: unknown, req: AdminRequest) {
    const parsed = updateUserSchema.parse(body);

    const current = await this.prisma.user.findUnique({
      where: { id },
      select: {
        ...USER_REF_SELECT,
        verifiedStatus: true,
        verifiedAt: true,
        unverifiedAt: true,
        premium: true,
        premiumPlus: true,
        isOrganization: true,
      },
    });
    if (!current) throw new NotFoundException("User not found.");

    const data: Prisma.UserUpdateInput = {};
    const now = new Date();

    if (parsed.phone !== undefined) {
      try {
        data.phone = normalizePhone(parsed.phone);
      } catch {
        throw new BadRequestException("Invalid phone number format");
      }
    }

    if (parsed.username !== undefined) {
      if (parsed.username === null) {
        data.username = null;
        data.usernameIsSet = false;
      } else {
        const validated = validateUsername(parsed.username, {
          minLen: 2,
          allowReserved: true,
        });
        if (!validated.ok) throw new BadRequestException(validated.error);
        data.username = validated.username;
        data.usernameIsSet = true;
      }
    }

    if (parsed.name !== undefined) {
      data.name = parsed.name === null ? null : parsed.name || null;
    }

    if (parsed.bio !== undefined) {
      data.bio = parsed.bio === null ? null : parsed.bio || null;
    }

    // Link fields are written through the links service (rows + mirror columns); admin edits skip the verified gate.
    const legacyLinks: Partial<Record<LegacyLinkField, string | null>> = {};
    for (const [field, provider, legacy] of [
      ["rumbleUrl", "rumble", "rumble"],
      ["linkedinUrl", "linkedin", "linkedin"],
      ["youtubeUrl", "youtube", "youtube"],
    ] as const) {
      if (parsed[field] !== undefined)
        legacyLinks[legacy] = normalizeSocialProfileUrl(
          parsed[field],
          provider,
        );
    }
    if (parsed.website !== undefined) {
      const raw = (parsed.website ?? "").trim();
      if (!raw) {
        legacyLinks.website = null;
      } else {
        const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
        try {
          const safe = publicPreviewUrl(withScheme);
          if (!safe)
            throw new BadRequestException(
              "Use a public website URL without credentials or API secrets.",
            );
          const u = new URL(safe);
          u.hash = "";
          legacyLinks.website = u.toString();
        } catch {
          throw new BadRequestException("Website must be a valid URL.");
        }
      }
    }
    if (parsed.locationQuery !== undefined) {
      const q = (parsed.locationQuery ?? "").trim();
      if (!q) {
        data.locationInput = null;
        data.locationDisplay = null;
        data.locationZip = null;
        data.locationCity = null;
        data.locationCounty = null;
        data.locationState = null;
        data.locationCountry = null;
      } else {
        const loc = this.usersLocation.normalizeLocation(q);
        data.locationInput = loc.input;
        data.locationDisplay = loc.display;
        data.locationZip = loc.zip;
        data.locationCity = loc.city;
        data.locationCounty = loc.county;
        data.locationState = loc.state;
        data.locationCountry = loc.country;
      }
    }

    // Org invariant: org accounts must be verified AND have at least some form of premium access.
    // current.premium reflects all sources (Stripe + grants) as computed by EntitlementService.
    const effectiveVerifiedStatus =
      parsed.verifiedStatus ?? current.verifiedStatus;
    const effectiveIsOrganization =
      parsed.isOrganization ?? current.isOrganization;
    if (
      effectiveIsOrganization === true &&
      (!current.premium || effectiveVerifiedStatus === "none")
    ) {
      throw new BadRequestException(
        "Organization accounts must be verified and premium.",
      );
    }

    if (parsed.isOrganization !== undefined) {
      data.isOrganization = parsed.isOrganization;
    }

    const wasVerified = current.verifiedStatus !== "none";
    const nowVerified =
      parsed.verifiedStatus !== undefined
        ? parsed.verifiedStatus !== "none"
        : wasVerified;
    const isNewlyVerifying =
      !wasVerified && nowVerified && parsed.verifiedStatus !== undefined;

    if (parsed.verifiedStatus !== undefined) {
      if (parsed.verifiedStatus === "none") {
        data.verifiedStatus = "none";
        data.verifiedAt = null;
        data.unverifiedAt = now;
      } else if (!isNewlyVerifying) {
        // Already verified: allow identity ↔ manual without re-running verify side effects.
        data.verifiedStatus = parsed.verifiedStatus;
        data.verifiedAt = current.verifiedAt ?? now;
        data.unverifiedAt = null;
      }
      // Newly verifying: handled by UserVerificationService after the other field updates.
    }

    if (parsed.featureToggles !== undefined) {
      data.featureToggles = sanitizeFeatureToggles(parsed.featureToggles);
    }

    try {
      if (Object.keys(legacyLinks).length > 0) {
        await this.profileLinks.setLegacyFields(id, legacyLinks, {
          skipVerifyGate: true,
          emit: false, // the admin update below invalidates caches and emits.
        });
      }

      await this.prisma.user.update({ where: { id }, data });

      if (parsed.verifiedStatus !== undefined) {
        if (isNewlyVerifying) {
          await this.userVerification.verifyUser({
            userId: id,
            source: "admin_patch",
            adminUserId: req.user?.id,
            verifiedStatus:
              parsed.verifiedStatus === "identity" ? "identity" : "manual",
          });
        } else if (wasVerified && !nowVerified) {
          // Unverifying: pause Stripe sub, recompute tier (strips premium access).
          await this.billingService.onUserUnverified(id);
        } else if (wasVerified && nowVerified) {
          // Keep stale requests closed without repeating verification rewards.
          await this.userVerification.verifyUser({
            userId: id,
            source: "admin_patch",
            adminUserId: req.user?.id,
          });
          await this.entitlementService.recomputeAndApply(id);
        }
      }

      // Fetch the fresh user after all writes so the response reflects the computed state.
      const updated = await this.prisma.user.findUnique({ where: { id } });
      if (!updated) throw new NotFoundException("User not found.");

      // Invalidate public profile caches (profile + preview) so tier changes reflect immediately.
      try {
        await this.publicProfileCache.invalidateForUser({
          id: current.id,
          username: current.username ?? null,
        });
        await this.publicProfileCache.invalidateForUser({
          id: updated.id,
          username: updated.username ?? null,
        });
      } catch {
        // Best-effort cache invalidation; never fail admin updates.
      }

      // Realtime: user tier/profile changes should update their own UI and any related users.
      try {
        await this.usersPublicRealtime.emitPublicProfileUpdated(updated.id);
        this.usersMeRealtime.emitMeUpdatedFromUser(
          updated,
          "admin_user_updated",
        );
      } catch {
        // Best-effort
      }

      if (!current.premium && (updated.premium || updated.premiumPlus)) {
        this.slack.notifyPremiumGranted({
          userId: updated.id,
          username: updated.username ?? null,
          name: updated.name ?? null,
          tier: updated.premiumPlus ? "premiumPlus" : "premium",
          source: "admin",
        });
      }

      return { data: await this.toAdminUserDto(updated) };
    } catch (err: unknown) {
      if (
        isNotFound(err)
      ) {
        throw new NotFoundException("User not found.");
      }
      if (
        isUniqueViolation(err)
      ) {
        // Unique constraint violation (phone or username lower-ci index).
        throw new ConflictException("That value is already in use.");
      }
      throw err;
    }
  }
  async adminInitAvatar(id: string, body: unknown) {
    const { contentType } = z
      .object({ contentType: z.string().min(1) })
      .parse(body);
    const result = await this.uploads.initAvatarUpload(id, contentType);
    return { data: result };
  }
  async adminCommitAvatar(id: string, body: unknown) {
    const { key } = z.object({ key: z.string().min(1) }).parse(body);
    const result = await this.uploads.commitAvatarUpload(id, key);
    return { data: result };
  }
  async adminDeleteAvatar(id: string) {
    const result = await this.uploads.deleteAvatarForUser(id);
    return { data: result };
  }
  async adminInitBanner(id: string, body: unknown) {
    const { contentType } = z
      .object({ contentType: z.string().min(1) })
      .parse(body);
    const result = await this.uploads.initBannerUpload(id, contentType);
    return { data: result };
  }
  async adminCommitBanner(id: string, body: unknown) {
    const { key } = z.object({ key: z.string().min(1) }).parse(body);
    const result = await this.uploads.commitBannerUpload(id, key);
    return { data: result };
  }
  async adminDeleteBanner(id: string) {
    const result = await this.uploads.deleteBannerForUser(id);
    return { data: result };
  }
  async adjustCoins(req: AdminRequest, id: string, body: unknown) {
    const adminId = String(req.user?.id ?? "").trim();
    if (!adminId) throw new NotFoundException();
    const parsed = adjustCoinsSchema.parse(body);
    const data = await this.coinsService.adminAdjustCoins({
      adminUserId: adminId,
      targetUserId: id,
      delta: parsed.delta,
      reason: parsed.reason ?? null,
    });
    return { data };
  }
  async unverifyEmail(id: string) {
    const now = new Date();
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("User not found.");

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id },
        data: {
          emailVerifiedAt: null,
          emailVerificationRequestedAt: null,
        },
      });

      // Invalidate any outstanding verification links (best-effort).
      await tx.emailActionToken.updateMany({
        where: { userId: id, purpose: "verifyEmail", consumedAt: null },
        data: { consumedAt: now },
      });

      return u;
    });

    this.usersMeRealtime.emitMeUpdatedFromUser(updated, "email_unverified");
    return { data: await this.toAdminUserDto(updated) };
  }
}
