import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LandingService } from '../landing/landing.service';
import { readAdminAnalytics } from './admin-analytics.read';

@Injectable()
export class AdminAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly landing: LandingService,
  ) {}

  read(rangeParam: string) {
    return readAdminAnalytics(this.prisma, this.landing, rangeParam);
  }
}
