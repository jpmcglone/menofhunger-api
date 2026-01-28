import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import type { AuthedRequest } from './auth.guard';

@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = (req as any).cookies?.moh_session as string | undefined;
    const user = await this.auth.meFromSessionToken(token);
    (req as AuthedRequest).user = user ? { id: user.id } : undefined;
    return true;
  }
}

