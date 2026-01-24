import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../app/app-config.service';
import type { OtpProvider } from './otp-provider';

@Injectable()
export class TwilioVerifyOtpProvider implements OtpProvider {
  private readonly logger = new Logger(TwilioVerifyOtpProvider.name);

  constructor(private readonly appConfig: AppConfigService) {}

  private getClient() {
    const cfg = this.appConfig.twilioVerify();
    if (!cfg) return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require('twilio');
    return {
      cfg,
      client: twilio(cfg.accountSid, cfg.authToken),
    };
  }

  async start(to: string): Promise<void> {
    const ctx = this.getClient();
    if (!ctx) throw new Error('Twilio Verify is not configured');

    this.logger.log('Starting Verify SMS');
    await ctx.client.verify.v2
      .services(ctx.cfg.verifyServiceSid)
      .verifications.create({ to, channel: 'sms' });
  }

  async check(to: string, code: string): Promise<boolean> {
    const ctx = this.getClient();
    if (!ctx) throw new Error('Twilio Verify is not configured');

    const result = await ctx.client.verify.v2
      .services(ctx.cfg.verifyServiceSid)
      .verificationChecks.create({ to, code });
    return String(result?.status ?? '') === 'approved';
  }
}

