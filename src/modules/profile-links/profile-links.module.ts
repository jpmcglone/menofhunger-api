import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { XModule } from '../x/x.module';
import { LinksPageService } from './links-page.service';
import { ProfileLinksController } from './profile-links.controller';

@Module({
  imports: [AuthModule, UsersModule, XModule],
  controllers: [ProfileLinksController],
  providers: [LinksPageService],
})
export class ProfileLinksModule {}
