import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth.guard';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Gates Strava-specific endpoints behind the 'fitnessStrava' feature toggle.
 * Returns 404 so the Strava surface is invisible to users without the toggle.
 * The rest of the Fitness module (weight tracking, HealthKit, goals) is
 * available to all authenticated verified users without this guard.
 */
@Injectable()
export class FitnessStravaGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const userId = req.user?.id ?? null;
    if (!userId) throw new NotFoundException();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { featureToggles: true },
    });

    if (!user?.featureToggles?.includes('fitnessStrava')) {
      throw new NotFoundException();
    }

    return true;
  }
}
