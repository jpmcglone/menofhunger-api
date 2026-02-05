import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthedRequest } from './auth.guard';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class VerifiedGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const userId = req.user?.id ?? null;
    if (!userId) throw new UnauthorizedException();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { verifiedStatus: true },
    });
    if (!user) throw new UnauthorizedException();
    if ((user.verifiedStatus ?? 'none') === 'none') {
      throw new ForbiddenException('Verify to use chat.');
    }
    return true;
  }
}

