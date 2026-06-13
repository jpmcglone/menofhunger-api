import { z } from 'zod';
import { queryBoolean } from './query-boolean';

describe('queryBoolean', () => {
  const schema = queryBoolean().optional();

  it('parses falsy string encodings as false (the z.coerce.boolean footgun)', () => {
    for (const v of ['false', 'FALSE', '0', 'no', 'off', '']) {
      expect(schema.parse(v)).toBe(false);
    }
  });

  it('parses truthy string encodings as true', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'on']) {
      expect(schema.parse(v)).toBe(true);
    }
  });

  it('passes real booleans through', () => {
    expect(schema.parse(true)).toBe(true);
    expect(schema.parse(false)).toBe(false);
  });

  it('treats numbers like booleans', () => {
    expect(schema.parse(1)).toBe(true);
    expect(schema.parse(0)).toBe(false);
  });

  it('is optional (undefined stays undefined)', () => {
    expect(schema.parse(undefined)).toBeUndefined();
  });

  it('rejects unparseable values', () => {
    expect(() => schema.parse('maybe')).toThrow(z.ZodError);
  });
});
