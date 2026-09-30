import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { XConnectionService } from './x-connection.service';

const connectSchema = z.object({
  code: z.string().trim().min(1).max(2000),
  state: z.string().trim().min(1).max(200),
});

@ApiTags('integrations')
@Controller('me/integrations/x')
@UseGuards(AuthGuard)
export class XController {
  constructor(private readonly connections: XConnectionService) {}

  @Get()
  async status(@CurrentUserId() userId: string) {
    return { data: await this.connections.getStatus(userId) };
  }

  @Post('authorize')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  async authorize(@CurrentUserId() userId: string) {
    return { data: await this.connections.authorize(userId) };
  }

  @Post('connect')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  async connect(@CurrentUserId() userId: string, @Body() body: unknown) {
    const input = connectSchema.parse(body);
    return { data: await this.connections.connect(userId, input) };
  }

  @Delete()
  async disconnect(@CurrentUserId() userId: string) {
    return { data: await this.connections.disconnect(userId) };
  }
}
