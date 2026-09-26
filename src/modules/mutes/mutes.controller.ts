import { Body, Controller, Delete, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { MutesService } from './mutes.service';

const muteUserSchema = z.object({ user_id: z.string().trim().min(1) });

@ApiTags('Mutes')
@UseGuards(AuthGuard)
@Controller('mutes')
export class MutesController {
  constructor(
    private readonly mutes: MutesService,
    private readonly realtime: PresenceRealtimeService,
  ) {}

  @Post()
  async mute(@CurrentUserId() userId: string, @Body() body: unknown) {
    const { user_id } = muteUserSchema.parse(body);
    await this.mutes.mute(userId, user_id);
    this.realtime.emitUsersMeRefresh(userId, 'mute_changed');
    return { data: {} };
  }

  @Delete(':id')
  async unmute(@CurrentUserId() userId: string, @Param('id') id: string) {
    await this.mutes.unmute(userId, id);
    this.realtime.emitUsersMeRefresh(userId, 'mute_changed');
    return { data: {} };
  }
}
