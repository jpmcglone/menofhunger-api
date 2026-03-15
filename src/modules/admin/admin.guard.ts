import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { getSessionCookie } from '../../common/session-cookie';
import { AuthService, type SessionResult } from '../auth/auth.service';

export type AdminRequest = Request & { user?: { id: string } };

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const token = getSessionCookie(req);
    let result: SessionResult | null = null;
    try {
      result = await this.auth.meFromSessionToken(token);
    } catch {
      result = null;
    }

    // Hide existence of admin routes from non-admins (and logged-out users).
    if (!result || !result.user.siteAdmin) throw new NotFoundException();

    if (result.renewed && token) {
      const res = context.switchToHttp().getResponse<Response>();
      this.auth.setSessionCookie(token, result.expiresAt, res);
    }

    req.user = { id: result.user.id };
    return true;
  }
}
