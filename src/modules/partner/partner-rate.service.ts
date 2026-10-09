import { HttpException, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { RedisService } from '../redis/redis.service';

const INCREMENT = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],61) end; return n`;
@Injectable()
export class PartnerRateService {
  constructor(private readonly redis: RedisService) {}
  async check(buckets: Array<{ key: string; limit: number }>, res: Pick<Response, 'setHeader'>) {
    const now = Math.floor(Date.now() / 1000);
    const window = Math.floor(now / 60);
    const counts = await Promise.all(
      buckets.map(async (b) => ({
        ...b,
        count: Number(await this.redis.raw().eval(INCREMENT, 1, `partner:rate:${window}:${b.key}`)),
      })),
    );
    const limiting = counts.reduce((a, b) => (a.limit - a.count <= b.limit - b.count ? a : b));
    const reset = (window + 1) * 60;
    res.setHeader('X-RateLimit-Limit', limiting.limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limiting.limit - limiting.count));
    res.setHeader('X-RateLimit-Reset', reset);
    if (counts.some((b) => b.count > b.limit)) {
      res.setHeader('Retry-After', reset - now);
      throw new HttpException('Rate limit exceeded. Retry after the indicated delay.', 429);
    }
  }
}
