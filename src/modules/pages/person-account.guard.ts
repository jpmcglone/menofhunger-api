import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth.guard';
import { assertPersonAccount } from './pages.constants';

/** Blocks person-only work (billing, check-in, fitness, verify, coins, crew, WOTD likes) while acting as a page. */
@Injectable()
export class PersonAccountGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    assertPersonAccount(req.user?.accountKind);
    return true;
  }
}
