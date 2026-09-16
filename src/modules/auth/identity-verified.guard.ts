import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthedRequest } from './auth.guard';

/** Identity verification is required here; an old paid-tier flag is not a substitute. */
@Injectable()
export class IdentityVerifiedGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const userId = context.switchToHttp().getRequest<AuthedRequest>().user?.id;
    if (!userId) throw new UnauthorizedException();
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { verifiedStatus: true } });
    if (!user) throw new UnauthorizedException();
    if (user.verifiedStatus === 'none') throw new ForbiddenException('Verify your account to access this.');
    return true;
  }
}
