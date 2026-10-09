import { Body, Controller, Get, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type { AutoVerifyApplyDto, AutoVerifyPreviewDto, SiteConfigDto } from '../../common/dto';
import { AdminGuard } from './admin.guard';
import { AdminSiteConfigService } from './admin-site-config.service';
import { updateSchema, previewSchema, applySchema } from './admin-site-config.schemas';

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
