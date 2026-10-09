import { queryBoolean } from '../../common/validation/query-boolean';
import { z } from 'zod';

export const republishSchema = z.object({
  quote: queryBoolean().optional(),
  websters1828: queryBoolean().optional(),
});
