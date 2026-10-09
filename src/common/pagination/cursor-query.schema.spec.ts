import { cursorPageQuerySchema, defaultedCursorPageQuerySchema } from './cursor-query.schema';

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

describe('defaultedCursorPageQuerySchema', () => {
  it('applies a default limit and bounds the cursor length', () => {
    const schema = defaultedCursorPageQuerySchema({ maxLimit: 100, defaultLimit: 20, maxCursorLength: 5 });
    expect(schema.parse({})).toEqual({ limit: 20 });
    expect(schema.parse({ limit: '100', cursor: 'abcde' })).toEqual({ limit: 100, cursor: 'abcde' });
    expect(() => schema.parse({ cursor: 'abcdef' })).toThrow();
    expect(() => schema.parse({ limit: '101' })).toThrow();
  });
});
