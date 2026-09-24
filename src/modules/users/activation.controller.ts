import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from './users.decorator';
import { ActivationService } from './activation.service';

@Controller('users/me/activation')
@UseGuards(AuthGuard)
export class ActivationController {
  constructor(private readonly activation: ActivationService) {}

  @Get()
  async get(@CurrentUserId() userId: string) {
    return { data: await this.activation.get(userId) };
  }
}
