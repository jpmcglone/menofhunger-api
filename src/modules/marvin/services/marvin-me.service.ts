import { Injectable } from '@nestjs/common';
import type { MarvinMode } from '@prisma/client';
import { toAvatarVideoDto, type AvatarVideoDto } from '../../../common/dto/avatar-video.dto';
import type {
  MarvinContextCardDto,
  MarvinCreditSummaryDto,
  MarvinMeDto,
  MarvinModeDto,
} from '../../../common/dto/marvin';
import { publicAssetUrl } from '../../../common/assets/public-asset-url';
import { AppConfigService } from '../../app/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AI_CONSENT_VERSION } from './ai-consent';
import { MarvinBotIdentityService } from './marvin-bot-identity.service';
import { MarvinCreditService, type MarvCreditSummary } from './marvin-credit.service';

export function creditSummaryToDto(summary: MarvCreditSummary): MarvinCreditSummaryDto {
  return {
    credits: summary.credits,
    maxCredits: summary.maxCredits,
    creditsPerDay: summary.creditsPerDay,
    lastRefilledAt: summary.lastRefilledAt.toISOString(),
  };
}

/** Viewer-scoped Marv settings and status for `/marvin/me*`. */
@Injectable()
export class MarvinMeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly credits: MarvinCreditService,
    private readonly identity: MarvinBotIdentityService,
  ) {}

  async updatePreferences(
    userId: string,
    parsed: { preferredMode?: MarvinModeDto; aiConsent?: boolean },
  ): Promise<void> {
    if (parsed.preferredMode === undefined && parsed.aiConsent === undefined) return;
    const preferences = {
      ...(parsed.preferredMode !== undefined ? { preferredMode: parsed.preferredMode as MarvinMode } : {}),
      ...(parsed.aiConsent !== undefined ? { aiConsentAt: parsed.aiConsent ? new Date() : null, aiConsentVersion: parsed.aiConsent ? AI_CONSENT_VERSION : 0 } : {}),
    };
    await this.prisma.marvinUserSettings.upsert({
      where: { userId },
      update: preferences,
      create: { userId, ...preferences },
    });
  }

  async getContextCard(userId: string): Promise<MarvinContextCardDto | null> {
    const card = await this.prisma.userContextCard.findUnique({
      where: { userId },
      select: { cardText: true, source: true, updatedAt: true },
    });
    if (!card) return null;
    return {
      cardText: card.cardText,
      source: card.source,
      updatedAt: card.updatedAt.toISOString(),
    };
  }

  async buildMe(userId: string): Promise<MarvinMeDto> {
    const cfg = this.appConfig.marvBot();
    const [viewer, settings, summary] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { premium: true, premiumPlus: true },
      }),
      this.prisma.marvinUserSettings.findUnique({
        where: { userId },
        select: { preferredMode: true, disabledByAdmin: true, aiConsentAt: true, aiConsentVersion: true },
      }),
      this.credits.getSummary(userId),
    ]);

    const isPremium = Boolean(viewer?.premium || viewer?.premiumPlus);
    const disabled = settings?.disabledByAdmin ?? false;
    const marvUserId = await this.identity.getMarvUserId();

    let marvAvatarUrl: string | null = null;
    let marvAvatarVideo: AvatarVideoDto | null = null;
    if (marvUserId) {
      const marvRow = await this.prisma.user.findUnique({
        where: { id: marvUserId },
        select: { avatarKey: true, avatarVideoKey: true, avatarVideoDurationMs: true, avatarUpdatedAt: true },
      });
      marvAvatarUrl = publicAssetUrl({
        publicBaseUrl: this.appConfig.r2()?.publicBaseUrl ?? null,
        key: marvRow?.avatarKey ?? null,
        updatedAt: marvRow?.avatarUpdatedAt ?? null,
      });
      marvAvatarVideo = toAvatarVideoDto(marvRow ?? {}, this.appConfig.r2()?.publicBaseUrl ?? null);
    }

    const creditCfg = this.appConfig.marvCredits();

    return {
      enabled: cfg.enabled && !disabled,
      isPremium,
      preferredMode: (settings?.preferredMode ?? 'auto') as MarvinModeDto,
      aiConsentGranted: Boolean(settings?.aiConsentAt && settings.aiConsentVersion === AI_CONSENT_VERSION),
      credits: creditSummaryToDto(summary),
      costs: {
        fast: creditCfg.fastCost,
        regular: creditCfg.regularCost,
        smart: creditCfg.smartCost,
        webSearchSurcharge: creditCfg.webSearchCreditCost,
        visionPerImage: creditCfg.visionCreditCostPerImage,
        urlFetchSurcharge: creditCfg.urlFetchCreditCost,
      },
      marv: marvUserId
        ? {
            userId: marvUserId,
            username: cfg.username,
            displayName: cfg.displayName,
            avatarUrl: marvAvatarUrl,
            avatarVideo: marvAvatarVideo,
          }
        : null,
    };
  }
}
