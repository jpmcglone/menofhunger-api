import { Global, Module } from '@nestjs/common';
import { ViewerContextService } from './viewer-context.service';

@Global()
@Module({
  providers: [ViewerContextService],
  exports: [ViewerContextService],
})
export class ViewerContextModule {}

