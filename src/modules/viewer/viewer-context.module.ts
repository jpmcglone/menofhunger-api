import { ViewerBlockSetsService } from './viewer-block-sets.service';
import { Global, Module } from '@nestjs/common';
import { ViewerContextService } from './viewer-context.service';
import { PostVisibilityReadService } from './post-visibility-read.service';
import { CommunityGroupReadAccessService } from './community-group-read-access.service';
import { GroupAccessService } from './group-access.service';
import { CrewAccessService } from './crew-access.service';

@Global()
@Module({
  providers: [ViewerBlockSetsService, ViewerContextService, PostVisibilityReadService, CommunityGroupReadAccessService, GroupAccessService, CrewAccessService],
  exports: [ViewerBlockSetsService, ViewerContextService, PostVisibilityReadService, CommunityGroupReadAccessService, GroupAccessService, CrewAccessService],
})
export class ViewerContextModule {}

