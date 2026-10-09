import { limitQuery } from '../../common/pagination/cursor-query.schema';
import { z } from 'zod';

export const searchSchema = z.object({
  q: z.string().trim().max(200).optional(),
  type: z.enum(['posts', 'users', 'bookmarks', 'all', 'articles', 'hashtags', 'taxonomy', 'cashtags', 'groups']).optional(),
  // Source hint for analytics/search-history recording.
  source: z.enum(['explore', 'external']).optional(),
  // Set by the client only after debounce settles or the user submits the query.
  record: z.enum(['1', 'true']).optional(),
  // Posts-only: filter by kind (e.g. allow "check-ins only" in search UI)
  kind: z.enum(['regular', 'checkin']).optional(),
  limit: limitQuery(50),
  cursor: z.string().optional(),
  userCursor: z.string().optional(),
  postCursor: z.string().optional(),
  articleCursor: z.string().optional(),
  collectionId: z.string().trim().min(1).optional(),
  unorganized: z.string().trim().optional(),
});
