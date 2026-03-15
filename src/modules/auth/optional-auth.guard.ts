import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { getSessionCookie } from '../../common/session-cookie';
import { AuthService } from './auth.service';
import type { AuthedRequest } from './auth.guard';

@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    const token = getSessionCookie(req);
    const result = await this.auth.meFromSessionToken(token);

    if (result) {
      if (result.renewed && token) {
        const res = context.switchToHttp().getResponse<Response>();
        this.auth.setSessionCookie(token, result.expiresAt, res);
      }
      (req as AuthedRequest).user = { id: result.user.id };
    } else {
      (req as AuthedRequest).user = undefined;
    }

    return true;
  }
}
