import { BadRequestException, Body, Controller, Get, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ModuleRef } from '@nestjs/core';
import { z } from 'zod';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { getSessionCookie } from '../../common/session-cookie';
import { AuthService } from './auth.service';
import { AccountDeletionService } from './account-deletion.service';
import { OTP_CODE_LENGTH } from './auth.constants';
import { normalizePhone } from './auth.utils';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MessagesService } from '../messages/messages.service';

const startSchema = z.object({
  phone: z.string().min(1),
});

const existsQuerySchema = z.object({
  phone: z.string().min(1),
});

const deleteAccountSchema = z.object({
  reason: z.string().max(100).optional().nullable(),
  details: z.string().max(2000).optional().nullable(),
});

const verifySchema = z.object({
  phone: z.string().min(1),
  code: z
    .string()
    .min(OTP_CODE_LENGTH)
    .max(OTP_CODE_LENGTH)
    .regex(/^\d+$/, 'Code must be numeric'),
  referralCode: z.string().max(50).optional().nullable(),
});

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly accountDeletion: AccountDeletionService,
    private readonly moduleRef: ModuleRef,
  ) {}

  @ApiOperation({ summary: 'Send 6-digit login code via SMS' })
  @Throttle({
    default: {
      limit: rateLimitLimit('authStart', 8),
      ttl: rateLimitTtl('authStart', 60),
    },
  })
  @Post('phone/start')
  async start(@Body() body: unknown) {
    const parsed = startSchema.parse(body);
    let phone: string;
    try {
      phone = normalizePhone(parsed.phone);
    } catch {
      throw new BadRequestException('Invalid phone number format');
    }
    const res = await this.auth.startPhoneAuth(phone);
    return { data: res };
  }

  /**
   * Lightweight check used by the login screen to decide whether to show the
   * first-time signup intro before sending an OTP. Intentionally returns only a
   * boolean — no PII, no enumeration risk beyond the existing /phone/start flow.
   */
  @ApiOperation({ summary: 'Check if a phone number has an existing account (lightweight, no PII)' })
  @Throttle({
    default: {
      limit: rateLimitLimit('authStart', 8),
      ttl: rateLimitTtl('authStart', 60),
    },
  })
  @Get('phone/exists')
  async exists(@Query() query: unknown) {
    const parsed = existsQuerySchema.parse(query);
    let phone: string;
    try {
      phone = normalizePhone(parsed.phone);
    } catch {
      throw new BadRequestException('Invalid phone number format');
    }
    const exists = await this.auth.phoneExists(phone);
    return { data: { exists } };
  }

  @ApiOperation({ summary: 'Verify SMS code and create/restore session (login or first-time signup)' })
  @Throttle({
    default: {
      limit: rateLimitLimit('authVerify', 20),
      ttl: rateLimitTtl('authVerify', 60),
    },
  })
  @Post('phone/verify')
  async verify(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const parsed = verifySchema.parse(body);
    let phone: string;
    try {
      phone = normalizePhone(parsed.phone);
    } catch {
      throw new BadRequestException('Invalid phone number format');
    }
    const result = await this.auth.verifyPhoneCode(phone, parsed.code, res, parsed.referralCode);
    return { data: result };
  }

  @ApiOperation({ summary: 'Get the authenticated user (me) plus live notification/message counts' })
  @Get('me')
  async me(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = getSessionCookie(req);
    const sessionResult = await this.auth.meFromSessionToken(token);
    if (!sessionResult?.user?.id) return { data: null };

    if (sessionResult.renewed && token) {
      this.auth.setSessionCookie(token, sessionResult.expiresAt, res);
    }

    // Run expensive per-request checks (pinned-post validity, streak self-heal) only here,
    // not in every auth guard invocation.
    let { user } = sessionResult;
    if (token) {
      user = await this.auth.runMeChecks(token, user.id, (user as any).pinnedPostId ?? null, user);
    }

    const notifications = this.moduleRef.get(NotificationsService, { strict: false });
    const messages = this.moduleRef.get(MessagesService, { strict: false });

    const [notificationCountRes, messageCountsRes] = await Promise.allSettled([
      notifications?.getUndeliveredCount(user.id) ?? Promise.resolve(0),
      messages?.getUnreadSummary(user.id) ?? Promise.resolve({ primary: 0, requests: 0 }),
    ]);

    const notificationUndeliveredCount =
      notificationCountRes.status === 'fulfilled'
        ? Math.max(0, Math.floor(Number(notificationCountRes.value) || 0))
        : 0;
    const messageUnreadCounts =
      messageCountsRes.status === 'fulfilled'
        ? {
            primary: Math.max(0, Math.floor(Number(messageCountsRes.value?.primary) || 0)),
            requests: Math.max(0, Math.floor(Number(messageCountsRes.value?.requests) || 0)),
          }
        : { primary: 0, requests: 0 };

    return {
      data: {
        ...user,
        notificationUndeliveredCount,
        messageUnreadCounts,
      },
    };
  }

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

    const parsed = deleteAccountSchema.parse(body ?? {});
    const result = await this.accountDeletion.requestDeletion(userId, {
      reason: parsed.reason ?? null,
      details: parsed.details ?? null,
    });

    // Sessions are already revoked server-side; also clear this client's cookie.
    await this.auth.logout(token, res);
    return { data: result };
  }

  @ApiOperation({ summary: 'Logout current session, clear cookie, and disconnect realtime sockets' })
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = getSessionCookie(req);
    const sessionResult = await this.auth.meFromSessionToken(token);
    const result = await this.auth.logout(token, res);
    // Disconnect all active sockets for this user immediately on logout.
    if (sessionResult?.user?.id) {
      // Avoid module import cycles by resolving at runtime (PresenceModule is loaded in AppModule).
      const presenceRealtime = this.moduleRef.get(PresenceRealtimeService, { strict: false });
      presenceRealtime?.disconnectUserSockets(sessionResult.user.id);
    }
    return { data: result };
  }
}

