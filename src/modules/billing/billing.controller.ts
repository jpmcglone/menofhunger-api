import { BadRequestException, Body, Controller, Delete, Get, Headers, Post, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import type { BillingCheckoutSessionDto, BillingMeDto, BillingPortalSessionDto, BillingTier, ReferralMeDto, RecruitDto } from '../../common/dto';
import { BillingService } from './billing.service';
import { ReferralService } from './referral.service';

const checkoutSchema = z.object({
  tier: z.enum(['premium', 'premiumPlus']),
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

