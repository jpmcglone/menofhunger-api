import { BadRequestException, Body, Controller, Get, Headers, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import type { BillingCheckoutSessionDto, BillingMeDto, BillingPortalSessionDto, BillingTier } from '../../common/dto';
import { BillingService } from './billing.service';

const checkoutSchema = z.object({
  tier: z.enum(['premium', 'premiumPlus']),
});

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

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

