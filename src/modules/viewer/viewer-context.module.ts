import { Global, Module } from '@nestjs/common';
import { ViewerContextService } from './viewer-context.service';
import { PostVisibilityReadService } from './post-visibility-read.service';
import { CommunityGroupReadAccessService } from './community-group-read-access.service';

@Global()
@Module({
  providers: [ViewerContextService, PostVisibilityReadService, CommunityGroupReadAccessService],
  exports: [ViewerContextService, PostVisibilityReadService, CommunityGroupReadAccessService],
})
export class ViewerContextModule {}

