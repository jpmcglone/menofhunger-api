import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { getSessionCookie } from '../../common/session-cookie';
import { AuthService } from './auth.service';
import type { AuthedRequest } from './auth.guard';

@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    const token = getSessionCookie(req);
    const user = await this.auth.meFromSessionToken(token);
    (req as AuthedRequest).user = user ? { id: user.id } : undefined;
    return true;
  }
}

