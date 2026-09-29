import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { PickaxConnectionService } from './pickax-connection.service';

const connectSchema = z.object({
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().min(1).max(500),
  username: z.string().trim().max(200).optional(),
});

@ApiTags('integrations')
@Controller('me/integrations/pickax')
@UseGuards(AuthGuard)
export class PickaxController {
  constructor(private readonly connections: PickaxConnectionService) {}

  @Get()
  async status(@CurrentUserId() userId: string) {
    return { data: { ...(await this.connections.getStatus(userId)), needsUsername: false } };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  async connect(@CurrentUserId() userId: string, @Body() body: unknown) {
    const input = connectSchema.parse(body);
    const result = await this.connections.connect(userId, input);
    return { data: { ...result.status, needsUsername: result.needsUsername } };
  }

  @Delete()
  async disconnect(@CurrentUserId() userId: string) {
    return { data: { ...(await this.connections.disconnect(userId)), needsUsername: false } };
  }
}
