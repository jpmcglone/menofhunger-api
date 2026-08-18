import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ModuleRef } from '@nestjs/core';
import { z } from 'zod';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { getSessionCookie } from '../../common/session-cookie';
import { AuthService, type SessionResult } from './auth.service';
import { AccountDeletionService } from './account-deletion.service';
import { OTP_CODE_LENGTH } from './auth.constants';
import { normalizePhone } from './auth.utils';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MessagesService } from '../messages/messages.service';
import { CrewInvitesService } from '../crew/crew-invites.service';
import type { AuthMeDto } from '../../common/dto/auth.dto';
import type { BrowserHandoffDto } from '../../common/dto';
import { AuthGuard, type AuthedRequest } from './auth.guard';
import { BrowserHandoffService } from './browser-handoff.service';
import { ImpersonationService } from './impersonation.service';
import { AccountSwitchService } from './account-switch.service';
import { PrismaService } from '../prisma/prisma.service';
import { totalUserArticlesWhere, totalUserPostsWhere } from '../../common/content-counts';
import { assertPersonAccount } from '../pages/pages.constants';

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

const browserHandoffSchema = z.object({
  destination: z.string().max(2048).optional(),
});

const browserHandoffRedeemSchema = z.object({
  code: z.string().min(1).max(256),
});

/**
 * Irreversible account-level actions are refused while a site admin is impersonating.
 * An admin debugging someone's account must never be able to delete it or sign them out
 * of all their devices.
 */
function assertNotImpersonating(session: SessionResult | null, action: string): void {
  if (!session?.impersonatedByUserId) return;
  throw new ForbiddenException({
    message: `You are signed in as another user. Exit impersonation before trying to ${action}.`,
    error: 'impersonation_forbidden',
  });
}

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
    private readonly browserHandoff: BrowserHandoffService,
    private readonly impersonation: ImpersonationService,
    private readonly accountSwitch: AccountSwitchService,
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

  @ApiOperation({ summary: 'Create a short-lived one-time external browser authentication handoff' })
  @Throttle({
    default: {
      limit: rateLimitLimit('authStart', 4),
      ttl: rateLimitTtl('authStart', 60),
    },
  })
  @UseGuards(AuthGuard)
  @Post('browser-handoff')
  async createBrowserHandoff(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ): Promise<{ data: BrowserHandoffDto }> {
    const userId = req.user?.id;
    if (!userId) throw new UnauthorizedException();
    const parsed = browserHandoffSchema.parse(body ?? {});
    const handoff = await this.browserHandoff.mint(userId, parsed.destination);
    return { data: handoff };
  }

  @ApiOperation({ summary: 'Redeem a one-time browser authentication handoff' })
  @Throttle({
    default: {
      limit: rateLimitLimit('authVerify', 20),
      ttl: rateLimitTtl('authVerify', 60),
    },
  })
  @Get('browser-handoff/redeem')
  async redeemBrowserHandoff(@Query() query: unknown, @Res() res: Response): Promise<void> {
    let code: string;
    try {
      code = browserHandoffRedeemSchema.parse(query).code;
    } catch {
      res.redirect(302, this.browserHandoff.invalidRedirectUrl());
      return;
    }

    try {
      const redemption = await this.browserHandoff.redeem(code, res);
      res.redirect(302, redemption?.destinationUrl ?? this.browserHandoff.invalidRedirectUrl());
    } catch {
      res.redirect(302, this.browserHandoff.invalidRedirectUrl());
    }
  }

  @ApiOperation({ summary: 'Get the authenticated user (me) plus live notification/message counts' })
  @Get('me')
  async me(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: AuthMeDto | null }> {
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
    let crewInvites: CrewInvitesService | null = null;
    let prisma: PrismaService | null = null;
    try {
      crewInvites = this.moduleRef.get(CrewInvitesService, { strict: false });
    } catch {
      // CrewModule can be absent in focused test/application contexts.
    }
    try {
      prisma = this.moduleRef.get(PrismaService, { strict: false });
    } catch {
      // Prisma can be absent in focused test/application contexts.
    }

    const [
      notificationCountRes,
      notificationUnreadCommentCountRes,
      groupsUnreadRes,
      crewInviteInboxCountRes,
      messageCountsRes,
      postCountRes,
      articleCountRes,
      impersonationRes,
      accountSwitchRes,
    ] = await Promise.allSettled([
      notifications?.getUndeliveredCount(user.id) ?? Promise.resolve(0),
      notifications?.getUnreadCommentCount(user.id) ?? Promise.resolve(0),
      notifications?.getGroupsUnread(user.id) ?? Promise.resolve({ total: 0, byGroupId: {} }),
      crewInvites?.countInboxPending(user.id) ?? Promise.resolve(0),
      messages?.getUnreadSummary(user.id) ?? Promise.resolve({ primary: 0, requests: 0 }),
      prisma?.post.count({ where: totalUserPostsWhere(user.id) }) ?? Promise.resolve(null),
      prisma?.article.count({ where: totalUserArticlesWhere(user.id) }) ?? Promise.resolve(null),
      this.impersonation.describe(sessionResult.impersonatedByUserId),
      this.accountSwitch.describe(sessionResult.operatedByUserId),
    ]);

    const notificationUndeliveredCount =
      notificationCountRes.status === 'fulfilled'
        ? Math.max(0, Math.floor(Number(notificationCountRes.value) || 0))
        : 0;
    const notificationUnreadCommentCount =
      notificationUnreadCommentCountRes.status === 'fulfilled'
        ? Math.max(0, Math.floor(Number(notificationUnreadCommentCountRes.value) || 0))
        : 0;
    const groupsUnread =
      groupsUnreadRes.status === 'fulfilled'
        ? {
            total: Math.max(0, Math.floor(Number(groupsUnreadRes.value?.total) || 0)),
            byGroupId: Object.fromEntries(
              Object.entries(groupsUnreadRes.value?.byGroupId ?? {}).map(([groupId, count]) => [
                groupId,
                Math.max(0, Math.floor(Number(count) || 0)),
              ]),
            ),
          }
        : { total: 0, byGroupId: {} };
    const crewInviteInboxCount =
      crewInviteInboxCountRes.status === 'fulfilled'
        ? Math.max(0, Math.floor(Number(crewInviteInboxCountRes.value) || 0))
        : 0;
    const messageUnreadCounts =
      messageCountsRes.status === 'fulfilled'
        ? {
            primary: Math.max(0, Math.floor(Number(messageCountsRes.value?.primary) || 0)),
            requests: Math.max(0, Math.floor(Number(messageCountsRes.value?.requests) || 0)),
          }
        : { primary: 0, requests: 0 };
    const postCount =
      postCountRes.status === 'fulfilled' && typeof postCountRes.value === 'number'
        ? Math.max(0, Math.floor(postCountRes.value))
        : null;
    const articleCount =
      articleCountRes.status === 'fulfilled' && typeof articleCountRes.value === 'number'
        ? Math.max(0, Math.floor(articleCountRes.value))
        : null;

    const impersonation =
      impersonationRes.status === 'fulfilled' ? impersonationRes.value ?? null : null;
    const accountSwitch =
      accountSwitchRes.status === 'fulfilled' ? accountSwitchRes.value ?? null : null;

    return {
      data: {
        ...user,
        notificationUndeliveredCount,
        notificationUnreadCommentCount,
        groupsUnread,
        crewInviteInboxCount,
        messageUnreadCounts,
        postCount,
        articleCount,
        impersonation,
        accountSwitch,
      },
    };
  }

  @ApiOperation({ summary: 'List the person + pages this session can switch into' })
  @UseGuards(AuthGuard)
  @Get('accounts')
  async listAccounts(@Req() req: AuthedRequest) {
    const token = getSessionCookie(req);
    const session = await this.auth.meFromSessionToken(token);
    if (!session) throw new UnauthorizedException();
    const data = await this.accountSwitch.listAccounts({
      effectiveUserId: session.user.id,
      operatedByUserId: session.operatedByUserId,
      accountKind: session.user.accountKind,
    });
    return { data };
  }

  @ApiOperation({ summary: 'Switch this client’s session to a page or back to the person' })
  @UseGuards(AuthGuard)
  @Post('switch')
  async switchAccount(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    const token = getSessionCookie(req);
    const session = await this.auth.meFromSessionToken(token);
    if (!session) throw new UnauthorizedException();
    const parsed = z.object({ userId: z.string().min(1) }).parse(body);
    const result = await this.accountSwitch.switchTo({
      currentUserId: session.user.id,
      operatedByUserId: session.operatedByUserId,
      impersonatedByUserId: session.impersonatedByUserId,
      accountKind: session.user.accountKind,
      targetUserId: parsed.userId,
      currentToken: token,
      res,
    });
    return { data: result };
  }

  @ApiOperation({
    summary: 'Stop admin impersonation and restore the admin’s own session',
  })
  @Throttle({
    default: {
      limit: rateLimitLimit('authStart', 10),
      ttl: rateLimitTtl('authStart', 60),
    },
  })
  @Post('impersonate/stop')
  async stopImpersonation(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = getSessionCookie(req);
    // Deliberately no `disconnectUserSockets` here: that would also drop the real user's
    // own devices. The client that started impersonation reconnects its own socket with
    // the restored cookie (same contract as login).
    const result = await this.impersonation.stop(token, res);
    return { data: result };
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

  @ApiOperation({ summary: 'Revoke all sessions for this user on every device, clear cookie, and disconnect all sockets' })
  @Throttle({
    default: {
      limit: rateLimitLimit('authStart', 4),
      ttl: rateLimitTtl('authStart', 60),
    },
  })
  @Post('sessions/revoke-all')
  async revokeAllSessions(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = getSessionCookie(req);
    const sessionResult = await this.auth.meFromSessionToken(token);
    if (!sessionResult?.user?.id) throw new UnauthorizedException('You must be signed in.');
    assertNotImpersonating(sessionResult, 'sign this account out everywhere');

    await this.auth.revokeAllSessionsForUser(sessionResult.user.id);
    this.auth.clearAuthCookie(res);

    const presenceRealtime = this.moduleRef.get(PresenceRealtimeService, { strict: false });
    presenceRealtime?.disconnectUserSockets(sessionResult.user.id);

    return { data: { success: true } };
  }
}

