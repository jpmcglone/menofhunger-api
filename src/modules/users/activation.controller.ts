import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth-public-api';
import { CurrentUserId } from './users.decorator';
import { ActivationService } from './activation.service';

@Controller('users/me/activation')
@UseGuards(AuthGuard)
export class ActivationController {
  constructor(private readonly activation: ActivationService) {}

  @Post('completion')
  async claimCompletion(@CurrentUserId() userId: string) {
    return { data: await this.activation.claimCompletion(userId) };
  }

  @Get()
  async get(@CurrentUserId() userId: string) {
    return { data: await this.activation.get(userId) };
  }
}
