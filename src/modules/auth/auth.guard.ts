import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { getSessionCookie } from '../../common/session-cookie';
import { AuthService } from './auth.service';

export type AuthedRequest = Request & { user?: { id: string } };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = getSessionCookie(req);
    const user = await this.auth.meFromSessionToken(token);
    if (!user) throw new UnauthorizedException();
    req.user = { id: user.id };
    return true;
  }
}

