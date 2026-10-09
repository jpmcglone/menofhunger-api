import { Body, Controller, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { getSessionCookie } from '../../common/session-cookie';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { assertPersonAccount } from '../pages/pages.constants';
import { AccountDeletionService } from './account-deletion.service';
import { assertNotImpersonating } from './auth-session.guards';
import { AuthService } from './auth.service';
import { deleteAccountSchema } from './account-deletion.schemas';

/** Account-deletion routes. Same `/auth/account/*` paths as before; split from AuthController so AuthModule needs no billing/admin dependencies. */
@ApiTags('Auth')
@Controller('auth')
export class AccountDeletionController {
  constructor(
    private readonly auth: AuthService,
    private readonly accountDeletion: AccountDeletionService,
  ) {}

  @ApiOperation({ summary: 'Schedule account deletion with a 30-day grace period (self-service, App Store 5.1.1v)' })
  @Throttle({
    default: {
      limit: rateLimitLimit('authStart', 4),
      ttl: rateLimitTtl('authStart', 60),
    },
  })
  @Post('account/delete')
  async deleteAccount(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const token = getSessionCookie(req);
    const sessionResult = await this.auth.meFromSessionToken(token);
    const userId = sessionResult?.user?.id;
    if (!userId) throw new UnauthorizedException('You must be signed in to delete your account.');
    assertNotImpersonating(sessionResult, 'delete this account');
    assertPersonAccount(sessionResult.user.accountKind);

    const parsed = deleteAccountSchema.parse(body ?? {});
    const result = await this.accountDeletion.requestDeletion(userId, {
      reason: parsed.reason ?? null,
      details: parsed.details ?? null,
    });

    // Sessions are already revoked server-side; also clear this client's cookie.
    await this.auth.logout(token, res);
    return { data: result };
  }

  @Post('account/deletion-status')
  async deletionStatus(@Body() body: unknown) {
    const { token } = z.object({ token: z.string().uuid() }).parse(body);
    return { data: await this.accountDeletion.status(token) };
  }
}
