import { publicPreviewUrl } from "../../common/urls/public-preview-url";
import { normalizeSocialProfileUrl } from "../../common/urls/social-profile-url";
import { UsersProfileWriteService } from "./users-profile-write.service";
import { Injectable, BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "../auth/auth.service";
import { AppConfigService } from "../app/app-config.service";
import { FollowsService } from "../follows/follows.service";
import { validateUsername } from "./users.utils";
import { HEARD_ABOUT_US_OTHER_MAX, HEARD_ABOUT_US_VALUES, isFullyOnboarded, resolveHeardAboutUs, resolveOnboardingUsername } from "./onboarding.utils";
import { toUserDto } from "./user.dto";
import { PublicProfileCacheService } from "./public-profile-cache.service";
import type { PublicProfilePayload } from "./public-profiles.service";
import { UsersMeRealtimeService } from "./users-me-realtime.service";
import { UsersPublicRealtimeService } from "./users-public-realtime.service";
import { canonicalizeTopicValue } from "../../common/topics/topic-utils";
import { UsersLocationService } from "./users-location.service";
import { EmailVerificationService } from "../email/email-verification.service";
import { PosthogService } from "../../common/posthog/posthog.service";
import { SlackService } from "../../common/slack/slack.service";
import { PresenceService } from "../presence/presence.service";
import { MEMBERS_MAP_SNAPSHOT_SELECT, MembersMapRealtimeService } from "./members-map-realtime.service";
import { PostsReadService } from '../posts-read/posts-read.service';

const setUsernameSchema = z.object({
  username: z.string().min(1),
});

function normalizeWebsite(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) throw new BadRequestException("Website is required.");
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  let u: URL;
  try {
    const safe = publicPreviewUrl(withScheme);
    if (!safe)
      throw new BadRequestException(
        "Use a public website URL without credentials or API secrets.",
      );
    u = new URL(safe);
  } catch {
    throw new BadRequestException("Website must be a valid URL.");
  }
  if (!/^https?:$/.test(u.protocol))
    throw new BadRequestException("Website must be a valid URL.");
  // Remove default ports and normalize.
  u.hash = "";
  return u.toString();
}

const profileSchema = z.object({
  name: z.string().trim().max(50).optional(),
  bio: z.string().trim().max(160).optional(),
  email: z.union([z.string().trim().email(), z.literal("")]).optional(),
  interests: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  website: z.union([z.string().trim().max(200), z.literal("")]).optional(),
  rumbleUrl: z.string().trim().max(300).optional(),
  linkedinUrl: z.string().trim().max(300).optional(),
  youtubeUrl: z.string().trim().max(300).optional(),
  locationQuery: z.union([z.string().trim().max(80), z.literal("")]).optional(),
});

const onboardingSchema = z.object({
  username: z.string().min(1).optional(),
  name: z.string().trim().max(50).optional(),
  email: z.union([z.string().trim().email(), z.literal("")]).optional(),
  // Expect YYYY-MM-DD from client.
  birthdate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Birthdate must be a date (YYYY-MM-DD).")
    .optional(),
  interests: z
    .array(z.string().trim().min(1).max(40))
    .min(1)
    .max(30)
    .optional(),
  menOnlyConfirmed: z.boolean().optional(),
  locationQuery: z.union([z.string().trim().max(80), z.literal("")]).optional(),
  heardAboutUs: z.enum(HEARD_ABOUT_US_VALUES).optional(),
  heardAboutUsOther: z
    .string()
    .trim()
    .max(HEARD_ABOUT_US_OTHER_MAX)
    .optional()
    .nullable(),
});

function isAtLeast18(birthdateUtcMidnight: Date): boolean {
  // Compare by YYYY-MM-DD using UTC to avoid timezone edge cases.
  const yyyy = birthdateUtcMidnight.getUTCFullYear();
  const mm = birthdateUtcMidnight.getUTCMonth();
  const dd = birthdateUtcMidnight.getUTCDate();

  const now = new Date();
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const cutoff = new Date(
    Date.UTC(
      todayUtc.getUTCFullYear() - 18,
      todayUtc.getUTCMonth(),
      todayUtc.getUTCDate(),
    ),
  );

  const d = new Date(Date.UTC(yyyy, mm, dd));
  return d.getTime() <= cutoff.getTime();
}

const JOHN_USERNAME = "john";
const MENOFHUNGER_USERNAME = "menofhunger";

/** Viewer profile writes: username, onboarding, profile fields, and pinned post. */
@Injectable()
export class UsersMeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly followsService: FollowsService,
    private readonly publicProfileCache: PublicProfileCacheService<PublicProfilePayload>,
    private readonly usersMeRealtime: UsersMeRealtimeService,
    private readonly usersPublicRealtime: UsersPublicRealtimeService,
    private readonly usersLocation: UsersLocationService,
    private readonly emailVerification: EmailVerificationService,
    private readonly posthog: PosthogService,
    private readonly slack: SlackService,
    private readonly presence: PresenceService,
    private readonly auth: AuthService,
    private readonly profileWrite: UsersProfileWriteService,
    private readonly membersMapRealtime: MembersMapRealtimeService,
    private readonly postsRead: PostsReadService,
  ) {}

  /**
   * On first username set, bootstrap starter follows:
   * 1) New user follows @menofhunger (one-way) when that account exists.
   * 2) New user and @john follow each other when @john exists.
   *
   * Uses FollowsService so follow notifications go through the normal flow.
   */
  private async ensureStarterFollowsOnFirstUsernameSet(
    userId: string,
    newUsername: string,
  ): Promise<void> {
    const usernameLower = (newUsername ?? "").trim().toLowerCase();
    if (!usernameLower) return;

    // First: one-way follow to @menofhunger (if account exists).
    if (usernameLower !== MENOFHUNGER_USERNAME) {
      try {
        await this.followsService.follow({
          viewerUserId: userId,
          username: MENOFHUNGER_USERNAME,
          source: "starter",
        });
        // New users: enable reply notifications for starter follows.
        await this.followsService.setPostNotificationsEnabled({
          viewerUserId: userId,
          username: MENOFHUNGER_USERNAME,
          enabled: true,
        });
      } catch {
        // Best-effort: ignore if account doesn't exist or relation already exists.
      }
    }

    if (usernameLower === JOHN_USERNAME) return;

    const john = await this.prisma.user.findFirst({
      where: {
        usernameIsSet: true,
        username: { equals: JOHN_USERNAME, mode: "insensitive" },
      },
      select: { id: true },
    });
    if (!john) return;

    try {
      await this.followsService.follow({
        viewerUserId: userId,
        username: JOHN_USERNAME,
        source: "starter",
      });
      // New users: enable reply notifications for starter follows.
      await this.followsService.setPostNotificationsEnabled({
        viewerUserId: userId,
        username: JOHN_USERNAME,
        enabled: true,
      });
    } catch {
      // John may not exist or follow may already exist; ignore.
    }

    try {
      await this.followsService.follow({
        viewerUserId: john.id,
        username: newUsername.trim(),
        source: "starter",
      });
    } catch {
      // Idempotent or visibility; ignore.
    }
  }
  async setMyUsername(body: unknown, userId: string) {
    const parsedBody = setUsernameSchema.parse(body);
    const desired = (parsedBody.username ?? "").trim();
    if (!desired) throw new BadRequestException("Username is required.");

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found.");

    const currentLower = (user.username ?? "").trim().toLowerCase();
    const desiredLower = desired.toLowerCase();
    // Allow capitalization-only changes to the current username, even if the username doesn't meet
    // current validation rules (e.g. legacy/special-case usernames).
    if (currentLower && currentLower === desiredLower) {
      const updated = await this.prisma.user.update({
        where: { id: userId },
        data: { username: desired },
      });
      await this.publicProfileCache.invalidateForUser({
        id: updated.id,
        username: updated.username ?? null,
      });
      await this.usersPublicRealtime.emitPublicProfileUpdated(updated.id);
      this.presence.markSeenFromHttp(userId);
      return {
        data: {
          user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null),
        },
      };
    }

    if (user.usernameIsSet) {
      // Once set, the only change allowed is capitalization (handled above).
      throw new ConflictException("Username is already set.");
    }

    const parsed = validateUsername(desired);
    if (!parsed.ok) throw new BadRequestException(parsed.error);

    try {
      const updated = await this.prisma.user.update({
        where: { id: userId },
        data: {
          username: parsed.username,
          usernameIsSet: true,
        },
      });

      await this.ensureStarterFollowsOnFirstUsernameSet(
        userId,
        updated.username ?? parsed.username,
      );
      this.membersMapRealtime.notifyChange(userId, user, updated);

      await this.publicProfileCache.invalidateForUser({
        id: updated.id,
        username: updated.username ?? null,
      });
      await this.usersPublicRealtime.emitPublicProfileUpdated(updated.id);
      this.usersMeRealtime.emitMeUpdatedFromUser(updated, "username_set");
      this.presence.markSeenFromHttp(userId);
      return {
        data: {
          user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null),
        },
      };
    } catch (err: unknown) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new ConflictException("That username is taken.");
      }
      throw err;
    }
  }
  async updateMyProfile(
    body: unknown,
    userId: string,
  ) {
    const parsed = profileSchema.parse(body);

    try {
      const existing = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          email: true,
          username: true,
          name: true,
          ...MEMBERS_MAP_SNAPSHOT_SELECT,
        },
      });
      if (!existing) throw new NotFoundException("User not found.");

      const now = new Date();
      let nextEmail: string | null | undefined = undefined;
      let emailChanged = false;

      const update: Prisma.UserUpdateInput = {
        name: parsed.name === undefined ? undefined : parsed.name || null,
        bio: parsed.bio === undefined ? undefined : parsed.bio || null,
      };
      if (parsed.email !== undefined) {
        const cleaned = parsed.email.trim()
          ? parsed.email.trim().toLowerCase()
          : null;
        nextEmail = cleaned;
        emailChanged = (existing.email ?? null) !== cleaned;
        (update as any).email = cleaned;
        if (emailChanged) {
          (update as any).emailVerifiedAt = null;
          (update as any).emailVerificationRequestedAt = cleaned ? now : null;
        }
      }

      for (const [field, provider] of [
        ["rumbleUrl", "rumble"],
        ["linkedinUrl", "linkedin"],
        ["youtubeUrl", "youtube"],
      ] as const) {
        if (parsed[field] !== undefined)
          update[field] = normalizeSocialProfileUrl(parsed[field], provider);
      }
      if (parsed.website !== undefined) {
        const raw = (parsed.website ?? "").trim();
        update.website = raw ? normalizeWebsite(raw) : null;
      }

      if (parsed.locationQuery !== undefined) {
        const q = (parsed.locationQuery ?? "").trim();
        if (!q) {
          update.locationInput = null;
          update.locationDisplay = null;
          update.locationZip = null;
          update.locationCity = null;
          update.locationCounty = null;
          update.locationState = null;
          update.locationCountry = null;
        } else {
          const loc = this.usersLocation.normalizeLocation(q);
          update.locationInput = loc.input;
          update.locationDisplay = loc.display;
          update.locationZip = loc.zip;
          update.locationCity = loc.city;
          update.locationCounty = loc.county;
          update.locationState = loc.state;
          update.locationCountry = loc.country;
        }
      }

      if (parsed.interests !== undefined) {
        const cleaned = Array.from(
          new Set(parsed.interests.map((s) => s.trim()).filter(Boolean)),
        ).slice(0, 30);
        if (cleaned.length < 1)
          throw new BadRequestException("Select at least one interest.");
        const mapped = cleaned
          .map((s) => canonicalizeTopicValue(s))
          .filter(Boolean) as string[];
        if (mapped.length !== cleaned.length) {
          throw new BadRequestException(
            "Interests must be selected from the curated list.",
          );
        }
        update.interests = mapped;
      }

      const updated = await this.profileWrite.commit(
        userId,
        update,
        emailChanged,
      );
      this.presence.markSeenFromHttp(userId);
      this.membersMapRealtime.notifyChange(userId, existing, updated);

      if (emailChanged && nextEmail) {
        const greetingName =
          (updated.name ?? updated.username ?? "").trim() || null;
        // Best-effort: don't block profile updates on email send.
        void this.emailVerification
          .requestVerification({
            userId: updated.id,
            email: nextEmail,
            name: greetingName,
          })
          .catch(() => undefined);
      }
      return {
        data: {
          user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null),
        },
      };
    } catch (err: unknown) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new ConflictException("That email is already in use.");
      }
      throw err;
    }
  }
  async setPinnedPost(body: unknown, userId: string) {
    const parsed = z.object({ postId: z.string().min(1) }).parse(body);
    const postId = (parsed.postId ?? "").trim();
    if (!postId) throw new BadRequestException("postId is required.");

    const post = await this.postsRead.read.findFirst({
      where: { id: postId, deletedAt: null },
      select: { id: true, userId: true, visibility: true },
    });
    if (!post) throw new NotFoundException("Post not found.");
    if (post.userId !== userId) throw new NotFoundException("Post not found.");
    if (post.visibility === "onlyMe")
      throw new BadRequestException("Only-me posts cannot be pinned.");

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { pinnedPostId: postId },
      select: { id: true, username: true },
    });
    await this.publicProfileCache.invalidateForUser({
      id: updated.id,
      username: updated.username ?? null,
    });
    await this.usersPublicRealtime.emitPublicProfileUpdated(updated.id);
    void this.usersMeRealtime.emitMeUpdated(updated.id, "pinned_post_changed");
    return { data: { pinnedPostId: postId } };
  }
  async unpinPost(userId: string) {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { pinnedPostId: null },
      select: { id: true, username: true },
    });
    await this.publicProfileCache.invalidateForUser({
      id: updated.id,
      username: updated.username ?? null,
    });
    await this.usersPublicRealtime.emitPublicProfileUpdated(updated.id);
    void this.usersMeRealtime.emitMeUpdated(updated.id, "pinned_post_changed");
    return { data: { pinnedPostId: null } };
  }
  async updateMyOnboarding(
    body: unknown,
    userId: string,
  ) {
    const parsed = onboardingSchema.parse(body);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found.");

    const data: Prisma.UserUpdateInput = {};
    const now = new Date();
    let emailChanged = false;
    let nextEmail: string | null = user.email ?? null;
    let usernameFirstSet = false;

    if (user.menOnlyConfirmed && parsed.menOnlyConfirmed === false) {
      throw new BadRequestException("This confirmation cannot be removed.");
    }
    if (parsed.menOnlyConfirmed === true) {
      data.menOnlyConfirmed = true;
    }

    if (parsed.name !== undefined) {
      data.name = parsed.name || null;
    }

    if (parsed.email !== undefined) {
      const cleaned = parsed.email.trim()
        ? parsed.email.trim().toLowerCase()
        : null;
      emailChanged = (user.email ?? null) !== cleaned;
      nextEmail = cleaned;
      (data as any).email = cleaned;
      if (emailChanged) {
        (data as any).emailVerifiedAt = null;
        (data as any).emailVerificationRequestedAt = cleaned ? now : null;
      }
    }

    if (parsed.birthdate !== undefined) {
      // Birthdate is locked once set (client enforces this too, but keep server safe).
      if (user.birthdate) {
        const existing = user.birthdate.toISOString().slice(0, 10);
        if (existing !== parsed.birthdate) {
          throw new BadRequestException("Birthday is locked once set.");
        }
        // If it matches, ignore.
      } else {
        // Store as UTC midnight.
        const d = new Date(`${parsed.birthdate}T00:00:00.000Z`);
        if (Number.isNaN(d.getTime()))
          throw new BadRequestException("Invalid birthdate.");
        if (!isAtLeast18(d)) {
          throw new BadRequestException(
            "You must be at least 18 years old to join Men of Hunger.",
          );
        }
        data.birthdate = d;
      }
    }

    if (parsed.interests !== undefined) {
      const cleaned = Array.from(
        new Set(parsed.interests.map((s) => s.trim()).filter(Boolean)),
      ).slice(0, 30);
      if (cleaned.length < 1)
        throw new BadRequestException("Select at least one interest.");
      const mapped = cleaned
        .map((s) => canonicalizeTopicValue(s))
        .filter(Boolean) as string[];
      if (mapped.length !== cleaned.length) {
        throw new BadRequestException(
          "Interests must be selected from the curated list.",
        );
      }
      data.interests = mapped;
    }

    if (parsed.username !== undefined) {
      const resolved = resolveOnboardingUsername({
        desired: parsed.username,
        currentUsername: user.username,
        usernameIsSet: user.usernameIsSet,
      });
      if (resolved) {
        data.username = resolved.username;
        if ("usernameIsSet" in resolved) {
          data.usernameIsSet = true;
          usernameFirstSet = true;
        }
      }
    }

    if (parsed.heardAboutUs !== undefined) {
      const heard = resolveHeardAboutUs({
        heardAboutUs: parsed.heardAboutUs,
        heardAboutUsOther: parsed.heardAboutUsOther,
      });
      data.heardAboutUs = heard.heardAboutUs;
      data.heardAboutUsOther = heard.heardAboutUsOther;
    }

    // Optional ZIP — silently ignored if invalid (non-blocking for onboarding).
    if (parsed.locationQuery) {
      try {
        const loc = this.usersLocation.normalizeLocation(parsed.locationQuery);
        data.locationInput = loc.input;
        data.locationDisplay = loc.display;
        data.locationZip = loc.zip;
        data.locationCity = loc.city;
        data.locationCounty = loc.county;
        data.locationState = loc.state;
        data.locationCountry = loc.country;
      } catch {
        // Invalid ZIP — skip silently so onboarding still completes.
      }
    }

    const wasComplete = isFullyOnboarded(user);

    try {
      const updated = await this.prisma.user.update({
        where: { id: userId },
        data,
      });

      if (usernameFirstSet && updated.username) {
        await this.ensureStarterFollowsOnFirstUsernameSet(
          userId,
          updated.username,
        );
      }
      this.membersMapRealtime.notifyChange(userId, user, updated);

      if (!wasComplete && isFullyOnboarded(updated) && updated.username) {
        this.posthog.capture(userId, "onboarding_completed", {
          username: updated.username,
        });
        const r2PublicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
        const avatarUrl =
          r2PublicBaseUrl && updated.avatarKey
            ? `${r2PublicBaseUrl}/${updated.avatarKey}`
            : null;
        this.slack.notifyProfileComplete({
          userId,
          username: updated.username,
          name: updated.name ?? null,
          email: updated.email ?? null,
          location: updated.locationDisplay ?? updated.locationInput ?? null,
          interests: updated.interests ?? [],
          avatarUrl,
        });
      }

      await this.publicProfileCache.invalidateForUser({
        id: updated.id,
        username: updated.username ?? null,
      });
      // Bust the Redis session cache so the next /auth/me SSR call reads fresh user data
      // instead of the 30-second stale cache (which would re-show the onboarding gate on refresh).
      void this.auth.bustSessionCachesForUser(userId);
      await this.usersPublicRealtime.emitPublicProfileUpdated(updated.id);
      this.usersMeRealtime.emitMeUpdatedFromUser(
        updated,
        emailChanged ? "email_changed" : "onboarding_changed",
      );
      this.presence.markSeenFromHttp(userId);

      if (emailChanged && nextEmail) {
        const greetingName =
          (updated.name ?? updated.username ?? "").trim() || null;
        void this.emailVerification
          .requestVerification({
            userId: updated.id,
            email: nextEmail,
            name: greetingName,
          })
          .catch(() => undefined);
      }
      return {
        data: {
          user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null),
        },
      };
    } catch (err: unknown) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        // Could be username or email unique violations; keep it generic here.
        throw new ConflictException("That value is already in use.");
      }
      throw err;
    }
  }
}
