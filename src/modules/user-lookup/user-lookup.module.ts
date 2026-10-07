import { Global, Module } from '@nestjs/common';
import { UserLookupService } from './user-lookup.service';

@Global()
@Module({
  providers: [UserLookupService],
  exports: [UserLookupService],
})
export class UserLookupModule {}
