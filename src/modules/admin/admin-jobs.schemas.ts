import { queryBoolean } from '../../common/validation/query-boolean';
import { z } from 'zod';

export const hashtagBackfillSchema = z.object({
  /** Existing run id. If omitted, a new run is started. */
  runId: z.string().trim().min(1).optional(),
  /** Cursor post id (createdAt/id cursor). If omitted, uses stored run cursor. */
  cursor: z.string().trim().min(1).optional(),
  /** Batch size (posts per request). */
  batchSize: z.coerce.number().int().min(10).max(5_000).optional(),
  /** When true and starting a new run, reset hashtag tables before scanning. */
  reset: queryBoolean().optional(),
});

export const postsTopicsBackfillSchema = z.object({
  /** When true, recompute topics even if already set (drains the lookback window). */
  wipeExisting: queryBoolean().optional(),
  /** When true, loop batches until no matching posts remain (implied by wipeExisting). */
  runUntilEmpty: queryBoolean().optional(),
  /** Batch size (posts per batch). */
  batchSize: z.coerce.number().int().min(10).max(5_000).optional(),
  /** How far back to scan for posts. */
  lookbackDays: z.coerce.number().int().min(1).max(10_000).optional(),
});

export const normalizeTopicsSchema = z.object({
  /** When true, normalize users' interests arrays. */
  users: queryBoolean().optional(),
  /** When true, normalize TopicFollow.topic values. */
  follows: queryBoolean().optional(),
});
