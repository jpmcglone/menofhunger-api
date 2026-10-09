import { Module } from '@nestjs/common';
import { GroupsModule } from '../groups/groups.module';
import { GroupChannelsModule } from '../group-channels/group-channels.module';
import { CrewModule } from '../crew/crew.module';
import { FollowsModule } from '../follows/follows.module';
import { MutesModule } from '../mutes/mutes.module';
import { CheckinsModule } from '../checkins/checkins.module';
import { CoinsModule } from '../coins/coins.module';
import { OnboardingMatchesModule } from '../onboarding-matches/onboarding-matches.module';
import { ExploreModule } from '../explore/explore.module';
import { PublicModule } from '../public/public.module';
import { LandingModule } from '../landing/landing.module';

/** Aggregate wiring for groups, crews, social graph, and community discovery. Imports only; providers stay scoped to their own modules. */
@Module({
  imports: [
    GroupsModule,
    GroupChannelsModule,
    CrewModule,
    FollowsModule,
    MutesModule,
    CheckinsModule,
    CoinsModule,
    OnboardingMatchesModule,
    ExploreModule,
    PublicModule,
    LandingModule,
  ],
})
export class CommunityFeaturesModule {}
