import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FollowsModule } from '../follows/follows.module';
import { OnboardingMatchesController } from './onboarding-matches.controller';
import { OnboardingMatchesService } from './onboarding-matches.service';

@Module({
  imports: [AuthModule, FollowsModule],
  controllers: [OnboardingMatchesController],
  providers: [OnboardingMatchesService],
})
export class OnboardingMatchesModule {}
