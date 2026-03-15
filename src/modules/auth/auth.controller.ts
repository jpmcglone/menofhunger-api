import { BadRequestException, Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ModuleRef } from '@nestjs/core';
import { z } from 'zod';
import { getSessionCookie } from '../../common/session-cookie';
import { AuthService } from './auth.service';
import { OTP_CODE_LENGTH } from './auth.constants';
import { normalizePhone } from './auth.utils';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MessagesService } from '../messages/messages.service';

const startSchema = z.object({
  phone: z.string().min(1),
});

const verifySchema = z.object({
  phone: z.string().min(1),
  code: z
    .string()
    .min(OTP_CODE_LENGTH)
    .max(OTP_CODE_LENGTH)
    .regex(/^\d+$/, 'Code must be numeric'),
});

const existsSchema = z.object({
  phone: z.string().min(1),
});

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly moduleRef: ModuleRef,
  ) {}

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

  @Get('phone/exists')
  async exists(@Req() req: Request) {
    const parsed = existsSchema.parse(req.query);
    let phone: string;
    try {
      phone = normalizePhone(parsed.phone);
    } catch {
      throw new BadRequestException('Invalid phone number format');
    }
    const exists = await this.auth.phoneExists(phone);
    return { data: exists };
  }

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
    const result = await this.auth.verifyPhoneCode(phone, parsed.code, res);
    return { data: result };
  }

  @Get('me')
  async me(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = getSessionCookie(req);
    const sessionResult = await this.auth.meFromSessionToken(token);
    if (!sessionResult?.user?.id) return { data: null };

    if (sessionResult.renewed && token) {
      this.auth.setSessionCookie(token, sessionResult.expiresAt, res);
    }

    const { user } = sessionResult;

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

