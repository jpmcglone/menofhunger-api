import { PickaxOAuthService } from './pickax-oauth.service';
import { ConnectionIdempotencyService } from '../outbound/connection-idempotency.service';
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, UseGuards, Req, ForbiddenException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { PickaxConnectionService } from './pickax-connection.service';

const connectSchema = z.object({
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().min(1).max(500),
  username: z.string().trim().max(200).optional(),
});

@ApiTags('integrations')
@Controller('me/integrations/pickax')
@UseGuards(AuthGuard)
export class PickaxController {
  constructor(private readonly connections: PickaxConnectionService, private readonly idempotency: ConnectionIdempotencyService, private readonly oauth: PickaxOAuthService) {}

  @Get()
  async status(@CurrentUserId() userId: string) {
    return { data: { ...(await this.connections.getStatus(userId)), needsUsername: false, verificationCode: null } };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  async connect(@CurrentUserId() userId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    if (req.user?.impersonatedByUserId) throw new ForbiddenException('End impersonation before connecting an account.');
    const input = connectSchema.parse(body);
    const result = await this.idempotency.run(userId, req.path, req.get('Idempotency-Key'), input, () => this.connections.connect(userId, input, req.user?.operatedByUserId ?? userId));
    return {
      data: { ...result.status, needsUsername: result.needsUsername, verificationCode: result.verificationCode },
    };
  }

  @Post('reconnect')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  async reconnect(@CurrentUserId() userId: string, @Req() req: AuthedRequest) {
    if (req.user?.impersonatedByUserId) throw new ForbiddenException('End impersonation before reconnecting an account.');
    const status = await this.idempotency.run(userId, req.path, req.get('Idempotency-Key'), {},
      () => this.connections.reconnect(userId, req.user?.operatedByUserId ?? userId));
    return { data: { ...status, needsUsername: false, verificationCode: null } };
  }

  @Post('authorize')
  async authorizeOAuth(@CurrentUserId() userId: string, @Req() req: AuthedRequest, @Body() body: unknown) {
    if (req.user?.impersonatedByUserId) throw new ForbiddenException();
    const input = z.object({ continuation: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/).optional() }).parse(body ?? {});
    return { data: await this.oauth.authorize(userId, req.user?.operatedByUserId ?? userId, input.continuation) };
  }
  @Post('oauth/connect')
  async finishOAuth(@CurrentUserId() userId: string, @Req() req: AuthedRequest, @Body() body: unknown) {
    if (req.user?.impersonatedByUserId) throw new ForbiddenException();
    const input = z.object({ code: z.string().min(1).max(2000), state: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/) }).parse(body);
    return { data: await this.idempotency.run(userId, req.path, req.get('Idempotency-Key'), input, () => this.oauth.connect(req.user?.operatedByUserId ?? userId, input.code, input.state)) };
  }

  @Delete()
  async disconnect(@CurrentUserId() userId: string) {
    return { data: { ...(await this.connections.disconnect(userId)), needsUsername: false, verificationCode: null } };
  }
}
