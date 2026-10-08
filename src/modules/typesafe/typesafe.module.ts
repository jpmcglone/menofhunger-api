import { Global, Module } from '@nestjs/common';
import { AppConfigModule } from '../app/app-config.module';
import { JevSearchIntentService } from './jev-search-intent.service';
import { JevTopicsService } from './jev-topics.service';
import { TypeSafeService } from './typesafe.service';

/** Global so feature modules can inject typed decisions without importing each other. */
@Global()
@Module({
  imports: [AppConfigModule],
  providers: [TypeSafeService, JevTopicsService, JevSearchIntentService],
  exports: [TypeSafeService, JevTopicsService, JevSearchIntentService],
})
export class TypeSafeModule {}
