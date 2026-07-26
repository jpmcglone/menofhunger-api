import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { AuthService } from './auth.service';
import { toUserDto } from '../users/user.dto';
import { USER_DTO_SELECT } from '../../common/prisma-selects/user.select';
import { SlackService } from '../../common/slack/slack.service';
import type { ImpersonationDto } from '../../common/dto/auth.dto';

/**
 * Admin impersonation ("log in as another user").
 *
 * Model: one session cookie, with the session row pointing back at the admin.
 * Starting mints a NEW `Session` for the target user carrying
 * `impersonatedByUserId = admin.id` and swaps the `moh_session` cookie. The admin's own
 * sessions are left untouched, so their other tabs/devices stay signed in as themselves.
 * Stopping revokes the impersonation session and mints a fresh admin session.
 *
 * Deliberately a single cookie: iOS stores exactly one session token in the Keychain,
 * so a two-cookie scheme could not behave identically across clients.
 */
@Injectable()
export class ImpersonationService {
  private readonly logger = new Logger(ImpersonationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly auth: AuthService,
    private readonly slack: SlackService,
  ) {}

  private get publicBaseUrl(): string | null {
    return this.appConfig.r2()?.publicBaseUrl ?? null;
  }

  /**
   * Start impersonating `targetUsername` as site admin `adminUserId`.
   * Sets the session cookie on `res` and returns the target user DTO.
   */
  async start(adminUserId: string, targetUsername: string, res: Response) {
    const admin = await this.prisma.user.findUnique({
      where: { id: adminUserId },
      select: { id: true, username: true, siteAdmin: true, bannedAt: true },
    });
    // Defense in depth: AdminGuard already ran, but never mint a session off a stale flag.
    if (!admin || !admin.siteAdmin || admin.bannedAt) throw new NotFoundException();

    const username = targetUsername.trim().replace(/^@/, '').toLowerCase();
    if (!username) throw new BadRequestException('Enter a username.');

    const target = await this.prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
      select: USER_DTO_SELECT,
    });
    if (!target) throw new NotFoundException(`No user found with username @${username}.`);

    if (target.id === admin.id) {
      throw new BadRequestException('You are already signed in as yourself.');
    }
    // Blocked so no admin can ever take over another admin's account.
    if (target.siteAdmin) {
      throw new ForbiddenException('You cannot sign in as another site admin.');
    }
    if (target.bannedAt) {
      throw new BadRequestException(
        `@${target.username} is banned. Unban the account before signing in as them.`,
      );
    }

    const session = await this.auth.createSessionForUser(target.id, res, {
      impersonatedByUserId: admin.id,
    });

    await this.prisma.adminImpersonationLog.create({
      data: { adminUserId: admin.id, targetUserId: target.id, sessionId: session.id },
    });

    this.logger.warn(
      `[impersonation] start admin=@${admin.username}(${admin.id}) target=@${target.username}(${target.id}) session=${session.id}`,
    );
    void this.slack
      .send(`:detective: Admin impersonation started — @${admin.username} is now acting as @${target.username}`)
      .catch(() => undefined);

    return { user: toUserDto(target, this.publicBaseUrl) };
  }

  /**
   * Stop impersonating and return to the admin's own account.
   * Requires the current session to be an impersonation session.
   */
  async stop(token: string | undefined, res: Response) {
    if (!token) throw new UnauthorizedException('You must be signed in.');

    const session = await this.auth.meFromSessionToken(token);
    if (!session) throw new UnauthorizedException('You must be signed in.');

    const adminUserId = session.impersonatedByUserId;
    if (!adminUserId) {
      throw new BadRequestException('This session is not an impersonation session.');
    }

    const admin = await this.prisma.user.findUnique({
      where: { id: adminUserId },
      select: USER_DTO_SELECT,
    });

    // End the impersonation session either way, so a broken admin account can't trap the client.
    await this.auth.revokeSessionToken(token);
    await this.prisma.adminImpersonationLog.updateMany({
      where: { sessionId: session.sessionId, endedAt: null },
      data: { endedAt: new Date() },
    });

    if (!admin || admin.bannedAt) {
      this.auth.clearAuthCookie(res);
      this.logger.warn(
        `[impersonation] stop admin=${adminUserId} unavailable — signed out instead of restoring`,
      );
      return { user: null, signedOut: true };
    }

    await this.auth.createSessionForUser(admin.id, res);
    this.logger.warn(
      `[impersonation] stop admin=@${admin.username}(${admin.id}) target=${session.user.id}`,
    );

    return { user: toUserDto(admin, this.publicBaseUrl), signedOut: false };
  }

  /**
   * Describe the admin behind an impersonated session, for `GET /auth/me`.
   * Returns null for ordinary sessions.
   */
  async describe(adminUserId: string | null): Promise<ImpersonationDto | null> {
    if (!adminUserId) return null;
    const admin = await this.prisma.user.findUnique({
      where: { id: adminUserId },
      select: USER_DTO_SELECT,
    });
    if (!admin) return null;
    const dto = toUserDto(admin, this.publicBaseUrl);
    return {
      adminUserId: dto.id,
      adminUsername: dto.username,
      adminName: dto.name ?? null,
      adminAvatarUrl: dto.avatarUrl ?? null,
    };
  }
}
