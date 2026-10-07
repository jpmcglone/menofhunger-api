import { Body, Controller, Get, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { AutoVerifyApplyDto, AutoVerifyPreviewDto, SiteConfigDto } from '../../common/dto';
import { AdminGuard } from './admin.guard';
import { AdminSiteConfigService } from './admin-site-config.service';

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

@UseGuards(AdminGuard)
@Controller('admin/site-config')
export class AdminSiteConfigController {
  constructor(private readonly siteConfig: AdminSiteConfigService) {}

  @Get()
  get(): Promise<{ data: SiteConfigDto }> {
    return this.siteConfig.get();
  }

  @Patch()
  update(@Body() body: unknown): Promise<{ data: SiteConfigDto }> {
    return this.siteConfig.update(updateSchema.parse(body));
  }

  @Get('auto-verify/preview')
  previewAutoVerify(@Query() query: unknown): Promise<{ data: AutoVerifyPreviewDto }> {
    return this.siteConfig.previewAutoVerify(previewSchema.parse(query));
  }

  @Post('auto-verify/apply')
  applyAutoVerify(@Body() body: unknown): Promise<{ data: AutoVerifyApplyDto }> {
    return this.siteConfig.applyAutoVerify(applySchema.parse(body));
  }
}
