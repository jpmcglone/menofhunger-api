import { Global, Module } from '@nestjs/common';
import { AppConfigModule } from '../app/app-config.module';
import { JevTopicsService } from './jev-topics.service';
import { TypeSafeService } from './typesafe.service';

/** Global so feature modules can inject typed decisions without importing each other. */
@Global()
@Module({
  imports: [AppConfigModule],
  providers: [TypeSafeService, JevTopicsService],
  exports: [TypeSafeService, JevTopicsService],
})
export class TypeSafeModule {}
