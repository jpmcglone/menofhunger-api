import { Module } from '@nestjs/common';
import { RadioController } from './radio.controller';
import { RadioChatService } from './radio-chat.service';
import { RadioService } from './radio.service';

@Module({
  controllers: [RadioController],
  providers: [RadioService, RadioChatService],
  exports: [RadioService, RadioChatService],
})
export class RadioModule {}

