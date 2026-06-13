import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CashtagResultDto } from '../../common/dto';

@Injectable()
export class TickerService implements OnModuleInit {
  private readonly logger = new Logger(TickerService.name);
  private validSymbols = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.refresh().catch((err) => {
      this.logger.warn(`Initial ticker set load failed (empty set used): ${(err as Error).message}`);
    });
  }

  /** Returns true when `symbol` (case-insensitive) is a known ticker. */
  isValid(symbol: string): boolean {
    return this.validSymbols.has((symbol ?? '').trim().toUpperCase());
  }

  /** Reload the in-memory valid-symbol set from the database. */
  async refresh(): Promise<void> {
    const rows = await this.prisma.ticker.findMany({ select: { symbol: true } });
    this.validSymbols = new Set(rows.map((r) => r.symbol));
    this.logger.log(`Ticker set refreshed: ${this.validSymbols.size} symbols loaded`);
  }

  /**
   * Autocomplete: return tickers whose symbol starts with `q` (case-insensitive),
   * falling back to name contains `q`. Returns at most `limit` results.
   */
  async searchPrefix(q: string, limit: number): Promise<CashtagResultDto[]> {
    const raw = (q ?? '').trim().toUpperCase();
    if (!raw) return [];

    const symbolMatches = await this.prisma.ticker.findMany({
      where: { symbol: { startsWith: raw } },
      orderBy: { symbol: 'asc' },
      take: limit,
      select: { symbol: true, name: true },
    });

    const remaining = limit - symbolMatches.length;
    const symbolMatchSet = new Set(symbolMatches.map((r) => r.symbol));

    const nameMatches =
      remaining > 0
        ? await this.prisma.ticker.findMany({
            where: {
              symbol: { notIn: [...symbolMatchSet] },
              name: { contains: q.trim(), mode: 'insensitive' },
            },
            orderBy: { symbol: 'asc' },
            take: remaining,
            select: { symbol: true, name: true },
          })
        : [];

    return [...symbolMatches, ...nameMatches].map((r) => ({ symbol: r.symbol, name: r.name }));
  }

  /** Look up a single ticker by exact uppercase symbol. Returns null when not found. */
  async findBySymbol(symbol: string): Promise<CashtagResultDto | null> {
    const row = await this.prisma.ticker.findUnique({
      where: { symbol: symbol.trim().toUpperCase() },
      select: { symbol: true, name: true },
    });
    return row ? { symbol: row.symbol, name: row.name } : null;
  }
}
