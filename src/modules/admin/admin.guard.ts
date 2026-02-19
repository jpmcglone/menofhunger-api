import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { getSessionCookie } from '../../common/session-cookie';
import { AuthService } from '../auth/auth.service';

export type AdminRequest = Request & { user?: { id: string } };

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const token = getSessionCookie(req);
    let user: Awaited<ReturnType<AuthService['meFromSessionToken']>> | null = null;
    try {
      user = await this.auth.meFromSessionToken(token);
    } catch {
      user = null;
    }

    // Hide existence of admin routes from non-admins (and logged-out users).
    if (!user || !user.siteAdmin) throw new NotFoundException();

    req.user = { id: user.id };
    return true;
  }
}

