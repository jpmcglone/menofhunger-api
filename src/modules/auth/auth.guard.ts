import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { getSessionCookie } from '../../common/session-cookie';
import { AuthService } from './auth.service';

export type AuthedRequest = Request & { user?: { id: string } };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = getSessionCookie(req);
    const result = await this.auth.meFromSessionToken(token);
    if (!result) throw new UnauthorizedException();

    if (result.renewed && token) {
      const res = context.switchToHttp().getResponse<Response>();
      this.auth.setSessionCookie(token, result.expiresAt, res);
    }

    req.user = { id: result.user.id };
    return true;
  }
}
