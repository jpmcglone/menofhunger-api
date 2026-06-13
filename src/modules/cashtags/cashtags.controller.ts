import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { TickerService } from './ticker.service';

@Controller('cashtags')
export class CashtagsController {
  constructor(private readonly ticker: TickerService) {}

  /**
   * Look up a single ticker by symbol.
   * Used by the web client to render the "$SPY · SPDR S&P 500 ETF Trust" header on explore pages.
   */
  @Get(':symbol')
  async getBySymbol(@Param('symbol') symbol: string) {
    const result = await this.ticker.findBySymbol(symbol);
    if (!result) throw new NotFoundException('Ticker not found.');
    return { data: result };
  }
}
