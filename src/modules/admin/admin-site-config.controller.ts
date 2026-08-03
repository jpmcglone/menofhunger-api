import { BadRequestException, Body, Controller, Get, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
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
import { AdminGuard } from './admin.guard';

const updateSchema = z.object({
  postsPerWindow: z.coerce.number().int().min(1).max(100).optional(),
  windowSeconds: z.coerce.number().int().min(10).max(24 * 60 * 60).optional(),
  verifiedPostsPerWindow: z.coerce.number().int().min(1).max(100).optional(),
  verifiedWindowSeconds: z.coerce.number().int().min(10).max(24 * 60 * 60).optional(),
  premiumPostsPerWindow: z.coerce.number().int().min(1).max(100).optional(),
  premiumWindowSeconds: z.coerce.number().int().min(10).max(24 * 60 * 60).optional(),
  autoVerifyNewUsers: z.boolean().optional(),
  /** Literal referral code to scope auto-verify; null/empty clears the filter. */
  autoVerifyReferralCode: z.union([z.string().trim().max(50), z.null()]).optional(),
});

const previewSchema = z.object({
  referralCode: z.string().trim().min(1).max(50),
});

const applySchema = z.object({
  recruiterId: z.string().trim().min(1),
});

const AUTO_VERIFY_PREVIEW_LIMIT = 100;
const AUTO_VERIFY_APPLY_LIMIT = 500;

@UseGuards(AdminGuard)
@Controller('admin/site-config')
export class AdminSiteConfigController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteConfig: SiteConfigService,
    private readonly userVerification: UserVerificationService,
    private readonly appConfig: AppConfigService,
  ) {}

  @Get()
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

  @Patch()
  async update(@Body() body: unknown): Promise<{ data: SiteConfigDto }> {
    const parsed = updateSchema.parse(body);

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

  @Get('auto-verify/preview')
  async previewAutoVerify(@Query() query: unknown): Promise<{ data: AutoVerifyPreviewDto }> {
    const parsed = previewSchema.parse(query);
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
          avatarKey: true,
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
          }),
          createdAt: u.createdAt.toISOString(),
          recruitedAt: u.createdAt.toISOString(),
        })),
      },
    };
  }

  @Post('auto-verify/apply')
  async applyAutoVerify(@Body() body: unknown): Promise<{ data: AutoVerifyApplyDto }> {
    const parsed = applySchema.parse(body);
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
