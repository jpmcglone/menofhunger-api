import { cursorPageQuerySchema } from './cursor-query.schema';

describe('cursorPageQuerySchema', () => {
  it('coerces limit and keeps cursor optional', () => {
    expect(cursorPageQuerySchema().parse({ limit: '20', cursor: 'abc' })).toEqual({ limit: 20, cursor: 'abc' });
    expect(cursorPageQuerySchema().parse({})).toEqual({});
  });

  it('bounds limit to [1, max]', () => {
    expect(() => cursorPageQuerySchema().parse({ limit: '51' })).toThrow();
    expect(() => cursorPageQuerySchema().parse({ limit: '0' })).toThrow();
    expect(() => cursorPageQuerySchema().parse({ limit: '1.5' })).toThrow();
    expect(cursorPageQuerySchema(100).parse({ limit: '100' })).toEqual({ limit: 100 });
  });
});
