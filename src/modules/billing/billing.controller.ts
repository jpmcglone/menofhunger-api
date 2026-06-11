import { BadRequestException, Body, Controller, Delete, Get, Headers, Post, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import type { AffiliateSummaryDto, BillingCheckoutSessionDto, BillingMeDto, BillingPortalSessionDto, BillingTier, ReferralMeDto, RecruitDto } from '../../common/dto';
import { BillingService } from './billing.service';
import { ReferralService } from './referral.service';
import { AffiliateService } from './affiliate.service';

const checkoutSchema = z.object({
  tier: z.enum(['premium', 'premiumPlus']),
});

const checkoutSyncSchema = z.object({
  sessionId: z.string().min(1),
});

const setReferralCodeSchema = z.object({
  code: z.string().min(1),
});

const setRecruiterSchema = z.object({
  code: z.string().min(1),
});

@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly referral: ReferralService,
    private readonly affiliate: AffiliateService,
  ) {}

  @UseGuards(AuthGuard)
  @Get('me')
  async me(@CurrentUserId() userId: string): Promise<{ data: BillingMeDto }> {
    return { data: await this.billing.getMe(userId) };
  }

  @UseGuards(AuthGuard)
  @Post('checkout-session')
  async checkoutSession(@CurrentUserId() userId: string, @Body() body: unknown): Promise<{ data: BillingCheckoutSessionDto }> {
    const parsed = checkoutSchema.parse(body);
    return { data: await this.billing.createCheckoutSession({ userId, tier: parsed.tier as BillingTier }) };
  }

  /**
   * Syncs the Stripe checkout session with our DB on return from Checkout.
   * Idempotent — safe to call even if the webhook already ran.
   * Returns the caller's updated billing summary.
   */
  @UseGuards(AuthGuard)
  @Post('checkout-session/sync')
  async syncCheckoutSession(@CurrentUserId() userId: string, @Body() body: unknown): Promise<{ data: BillingMeDto }> {
    const parsed = checkoutSyncSchema.parse(body);
    return { data: await this.billing.syncCheckoutSession({ userId, sessionId: parsed.sessionId }) };
  }

  @UseGuards(AuthGuard)
  @Post('portal-session')
  async portalSession(@CurrentUserId() userId: string): Promise<{ data: BillingPortalSessionDto }> {
    return { data: await this.billing.createPortalSession({ userId }) };
  }

  // ─── Referral endpoints ───────────────────────────────────────────────────

  @UseGuards(AuthGuard)
  @Get('referral')
  async getReferral(@CurrentUserId() userId: string): Promise<{ data: ReferralMeDto }> {
    return { data: await this.referral.getMyReferralInfo(userId) };
  }

  @UseGuards(AuthGuard)
  @Put('referral/code')
  async setReferralCode(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ): Promise<{ data: { referralCode: string } }> {
    const parsed = setReferralCodeSchema.parse(body);
    return { data: await this.referral.setReferralCode(userId, parsed.code) };
  }

  @UseGuards(AuthGuard)
  @Get('referral/recruits')
  async getRecruits(@CurrentUserId() userId: string): Promise<{ data: RecruitDto[] }> {
    return { data: await this.referral.getMyRecruits(userId) };
  }

  @UseGuards(AuthGuard)
  @Post('referral/set-recruiter')
  async setRecruiter(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ): Promise<{ data: { recruiter: { username: string | null; name: string | null } } }> {
    const parsed = setRecruiterSchema.parse(body);
    return { data: await this.referral.setRecruiter(userId, parsed.code) };
  }

  // ─── Affiliate endpoints ──────────────────────────────────────────────────

  @UseGuards(AuthGuard)
  @Get('affiliate')
  async getAffiliate(@CurrentUserId() userId: string): Promise<{ data: AffiliateSummaryDto }> {
    return { data: await this.affiliate.getAffiliateSummary(userId) };
  }

  @UseGuards(AuthGuard)
  @Delete('dev-reset')
  async devReset(@CurrentUserId() userId: string): Promise<{ data: { reset: true } }> {
    await this.billing.devResetPremium(userId);
    return { data: { reset: true } };
  }

  /**
   * Stripe webhook (signature-verified).
   * IMPORTANT: this route must be excluded from CSRF origin checks in `main.ts`.
   */
  @Post('webhook')
  async webhook(
    @Req() req: Request,
    @Headers('stripe-signature') stripeSignature: string | undefined,
  ): Promise<{ data: { received: true } }> {
    if (!stripeSignature) throw new BadRequestException('Missing stripe-signature header.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawBody = (req as any).rawBody as Buffer | undefined;
    if (!rawBody || !(rawBody instanceof Buffer)) throw new BadRequestException('Missing raw request body.');

    await this.billing.handleWebhook({ rawBody, stripeSignature });
    return { data: { received: true } };
  }
}

