import { Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { EmailWebhookService } from './email-webhook.service';

@Controller('email/webhook')
export class EmailWebhookController {
  constructor(private readonly webhook: EmailWebhookService) {}

  @Post('resend')
  @HttpCode(200)
  async resend(@Req() request: Request, @Headers('svix-id') id?: string,
    @Headers('svix-timestamp') timestamp?: string, @Headers('svix-signature') signature?: string) {
    return { data: await this.webhook.receive(request.rawBody, { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature }) };
  }
}
