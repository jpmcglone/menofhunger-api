import { z } from 'zod';

/**
 * Query-string-safe boolean schema.
 *
 * `z.coerce.boolean()` is a footgun for query params: it runs `Boolean(value)`,
 * so the string `"false"` coerces to `true`. Clients that send `?flag=false`
 * therefore get the opposite of what they asked for. This helper parses the
 * truthy/falsy string encodings the way callers actually mean them.
 *
 * Accepts: real booleans, numbers (0 = false), and the strings
 * true/1/yes/on and false/0/no/off (case-insensitive). Empty string is false.
 */
export function queryBoolean() {
  return z.preprocess((val) => {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'number') return val !== 0;
    if (typeof val === 'string') {
      const v = val.trim().toLowerCase();
      if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
      if (v === 'false' || v === '0' || v === 'no' || v === 'off' || v === '') return false;
    }
    return val;
  }, z.boolean());
}
