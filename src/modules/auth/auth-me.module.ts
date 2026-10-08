import { Module } from '@nestjs/common';
import { AuthModule } from './auth.module';
import { CrewModule } from '../crew/crew.module';
import { GroupsModule } from '../groups/groups.module';
import { MessagesModule } from '../messages/messages.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthMeController } from './auth-me.controller';
import { AuthMeService } from './auth-me.service';

/** `/auth/me` aggregate. Separate from AuthModule because it depends on modules that import AuthModule. */
@Module({
  imports: [AuthModule, NotificationsModule, MessagesModule, CrewModule, GroupsModule],
  controllers: [AuthMeController],
  providers: [AuthMeService],
})
export class AuthMeModule {}
