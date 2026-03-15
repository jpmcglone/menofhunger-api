import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { CoinsService, transferCoinsSchema } from './coins.service';

@Controller('coins')
@UseGuards(AuthGuard)
export class CoinsController {
  constructor(private readonly coins: CoinsService) {}

  @Post('transfer')
  async transfer(@CurrentUserId() userId: string, @Body() body: unknown) {
    const parsed = transferCoinsSchema.parse(body);
    const result = await this.coins.transfer({
      senderUserId: userId,
      recipientUsername: parsed.recipientUsername,
      amount: parsed.amount,
      note: parsed.note ?? null,
    });
    return { data: result };
  }

  @Get('transfers')
  async listTransfers(
    @CurrentUserId() userId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, nextCursor } = await this.coins.listTransfers({
      userId,
      cursor: cursor ?? null,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return { data: items, pagination: { nextCursor } };
  }

  @Get('transfers/:transferId')
  async getTransferReceipt(
    @CurrentUserId() userId: string,
    @Param('transferId') transferId: string,
  ) {
    const data = await this.coins.getTransferReceipt({ userId, transferId });
    return { data };
  }
}
