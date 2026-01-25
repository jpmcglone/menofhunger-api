import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';

export type AdminRequest = Request & { user?: { id: string } };

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    // cookie-parser populates req.cookies
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = (req as any).cookies?.moh_session as string | undefined;
    const user = await this.auth.meFromSessionToken(token);

    // Hide existence of admin routes from non-admins (and logged-out users).
    if (!user || !user.siteAdmin) throw new NotFoundException();

    req.user = { id: user.id };
    return true;
  }
}

