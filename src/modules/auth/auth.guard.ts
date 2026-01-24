import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';

export type AuthedRequest = Request & { user?: { id: string } };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = (req as any).cookies?.moh_session as string | undefined;
    const user = await this.auth.meFromSessionToken(token);
    if (!user) throw new UnauthorizedException();
    req.user = { id: user.id };
    return true;
  }
}

