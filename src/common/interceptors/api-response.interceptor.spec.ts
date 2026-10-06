import { StreamableFile } from '@nestjs/common';
import { of, lastValueFrom } from 'rxjs';
import { ApiResponseInterceptor } from './api-response.interceptor';

describe('ApiResponseInterceptor', () => {
  const run = (body: unknown) => lastValueFrom(new ApiResponseInterceptor().intercept({} as never, { handle: () => of(body) }));

  it('wraps plain values in a data envelope', async () => {
    expect(await run({ a: 1 })).toEqual({ data: { a: 1 } });
  });

  it('passes binary streams through untouched', async () => {
    const file = new StreamableFile(Buffer.from('x'));
    expect(await run(file)).toBe(file);
  });
});
