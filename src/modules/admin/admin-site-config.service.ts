import { toAvatarVideoDto } from '../../common/dto/avatar-video.dto';
import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  AutoVerifyApplyDto,
  AutoVerifyPreviewDto,
  SiteConfigAutoVerifyRecruiterDto,
  SiteConfigDto,
} from '../../common/dto';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { SiteConfigService } from '../site-config/site-config.service';
import { UserVerificationService } from '../verification/user-verification.service';

export type SiteConfigUpdateInput = {
  postsPerWindow?: number;
  windowSeconds?: number;
  verifiedPostsPerWindow?: number;
  verifiedWindowSeconds?: number;
  premiumPostsPerWindow?: number;
  premiumWindowSeconds?: number;
  autoVerifyNewUsers?: boolean;
  autoVerifyReferralCode?: string | null;
};

const AUTO_VERIFY_PREVIEW_LIMIT = 100;
const AUTO_VERIFY_APPLY_LIMIT = 500;

@Injectable()
export class AdminSiteConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteConfig: SiteConfigService,
    private readonly userVerification: UserVerificationService,
    private readonly appConfig: AppConfigService,
  ) {}

  async get(): Promise<{ data: SiteConfigDto }> {
    const cfg = await this.siteConfig.getUncached();
    const autoVerifyRecruiter = await this.loadRecruiterSummary(cfg.autoVerifyRecruiterId);
    return {
      data: {
        id: cfg.id,
        postsPerWindow: cfg.postsPerWindow,
        windowSeconds: cfg.windowSeconds,
        verifiedPostsPerWindow: cfg.verifiedPostsPerWindow,
        verifiedWindowSeconds: cfg.verifiedWindowSeconds,
        premiumPostsPerWindow: cfg.premiumPostsPerWindow,
        premiumWindowSeconds: cfg.premiumWindowSeconds,
        autoVerifyNewUsers: cfg.autoVerifyNewUsers,
        autoVerifyRecruiter,
      },
    };
  }

  async update(parsed: SiteConfigUpdateInput): Promise<{ data: SiteConfigDto }> {

    let autoVerifyRecruiterId: string | null | undefined;
    if (parsed.autoVerifyReferralCode !== undefined) {
      const raw = (parsed.autoVerifyReferralCode ?? '').trim();
      if (!raw) {
        autoVerifyRecruiterId = null;
      } else {
        const recruiter = await this.prisma.user.findFirst({
          where: { referralCode: raw.toUpperCase() },
          select: { id: true },
        });
        if (!recruiter) throw new BadRequestException('Unknown referral code.');
        autoVerifyRecruiterId = recruiter.id;
      }
    }

    const updated = await this.prisma.siteConfig.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        postsPerWindow: parsed.postsPerWindow ?? 5,
        windowSeconds: parsed.windowSeconds ?? 300,
        verifiedPostsPerWindow: parsed.verifiedPostsPerWindow ?? 5,
        verifiedWindowSeconds: parsed.verifiedWindowSeconds ?? 300,
        premiumPostsPerWindow: parsed.premiumPostsPerWindow ?? 5,
        premiumWindowSeconds: parsed.premiumWindowSeconds ?? 300,
        autoVerifyNewUsers: parsed.autoVerifyNewUsers ?? false,
        autoVerifyRecruiterId: autoVerifyRecruiterId ?? null,
      },
      update: {
        ...(parsed.postsPerWindow !== undefined ? { postsPerWindow: parsed.postsPerWindow } : {}),
        ...(parsed.windowSeconds !== undefined ? { windowSeconds: parsed.windowSeconds } : {}),
        ...(parsed.verifiedPostsPerWindow !== undefined ? { verifiedPostsPerWindow: parsed.verifiedPostsPerWindow } : {}),
        ...(parsed.verifiedWindowSeconds !== undefined ? { verifiedWindowSeconds: parsed.verifiedWindowSeconds } : {}),
        ...(parsed.premiumPostsPerWindow !== undefined ? { premiumPostsPerWindow: parsed.premiumPostsPerWindow } : {}),
        ...(parsed.premiumWindowSeconds !== undefined ? { premiumWindowSeconds: parsed.premiumWindowSeconds } : {}),
        ...(parsed.autoVerifyNewUsers !== undefined ? { autoVerifyNewUsers: parsed.autoVerifyNewUsers } : {}),
        ...(autoVerifyRecruiterId !== undefined ? { autoVerifyRecruiterId } : {}),
      },
    });

    this.siteConfig.invalidate();

    const autoVerifyRecruiter = await this.loadRecruiterSummary(updated.autoVerifyRecruiterId);
    return {
      data: {
        id: updated.id,
        postsPerWindow: updated.postsPerWindow,
        windowSeconds: updated.windowSeconds,
        verifiedPostsPerWindow: updated.verifiedPostsPerWindow,
        verifiedWindowSeconds: updated.verifiedWindowSeconds,
        premiumPostsPerWindow: updated.premiumPostsPerWindow,
        premiumWindowSeconds: updated.premiumWindowSeconds,
        autoVerifyNewUsers: updated.autoVerifyNewUsers,
        autoVerifyRecruiter,
      },
    };
  }

  async previewAutoVerify(parsed: { referralCode: string }): Promise<{ data: AutoVerifyPreviewDto }> {
    const recruiter = await this.resolveRecruiterByCode(parsed.referralCode);
    const where = this.unverifiedRecruitsWhere(recruiter.id);

    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: AUTO_VERIFY_PREVIEW_LIMIT,
        select: {
          id: true,
          username: true,
          name: true,
          avatarKey: true, avatarVideoKey: true, avatarVideoDurationMs: true,
          avatarUpdatedAt: true,
          createdAt: true,
        },
      }),
    ]);

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    return {
      data: {
        recruiter,
        total,
        users: rows.map((u) => ({
          id: u.id,
          username: u.username ?? null,
          name: u.name ?? null,
          avatarUrl: publicAssetUrl({
            publicBaseUrl,
            key: u.avatarKey,
            updatedAt: u.avatarUpdatedAt,
          }), avatarVideo: toAvatarVideoDto(u, publicBaseUrl),
          createdAt: u.createdAt.toISOString(),
          recruitedAt: u.createdAt.toISOString(),
        })),
      },
    };
  }

  async applyAutoVerify(parsed: { recruiterId: string }): Promise<{ data: AutoVerifyApplyDto }> {
    const recruiterId = parsed.recruiterId.trim();
    const recruiter = await this.prisma.user.findUnique({
      where: { id: recruiterId },
      select: { id: true },
    });
    if (!recruiter) throw new BadRequestException('Unknown recruiter.');

    const where = this.unverifiedRecruitsWhere(recruiterId);
    const candidates = await this.prisma.user.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: AUTO_VERIFY_APPLY_LIMIT,
      select: { id: true },
    });

    let verifiedCount = 0;
    for (const candidate of candidates) {
      const result = await this.userVerification.verifyUser({
        userId: candidate.id,
        source: 'auto_referral',
      });
      if (result.verified) verifiedCount += 1;
    }

    const remaining = await this.prisma.user.count({ where });
    return { data: { verifiedCount, remaining } };
  }

  private unverifiedRecruitsWhere(recruiterId: string) {
    return {
      recruitedById: recruiterId,
      verifiedStatus: 'none' as const,
      bannedAt: null,
      deletionScheduledAt: null,
    };
  }

  private async resolveRecruiterByCode(code: string): Promise<SiteConfigAutoVerifyRecruiterDto> {
    const normalized = code.trim().toUpperCase();
    const recruiter = await this.prisma.user.findFirst({
      where: { referralCode: normalized },
      select: { id: true, username: true, name: true, referralCode: true },
    });
    if (!recruiter) throw new BadRequestException('Unknown referral code.');
    return {
      id: recruiter.id,
      username: recruiter.username ?? null,
      name: recruiter.name ?? null,
      referralCode: recruiter.referralCode ?? null,
    };
  }

  private async loadRecruiterSummary(recruiterId: string | null): Promise<SiteConfigAutoVerifyRecruiterDto | null> {
    if (!recruiterId) return null;
    const recruiter = await this.prisma.user.findUnique({
      where: { id: recruiterId },
      select: { id: true, username: true, name: true, referralCode: true },
    });
    if (!recruiter) return null;
    return {
      id: recruiter.id,
      username: recruiter.username ?? null,
      name: recruiter.name ?? null,
      referralCode: recruiter.referralCode ?? null,
    };
  }
}
