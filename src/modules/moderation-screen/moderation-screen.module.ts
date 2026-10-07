import { Global, Module } from '@nestjs/common';
import { AppConfigModule } from '../app/app-config.module';
import { ContentScreenService } from './content-screen.service';

@Global()
@Module({ imports: [AppConfigModule], providers: [ContentScreenService], exports: [ContentScreenService] })
export class ModerationScreenModule {}
