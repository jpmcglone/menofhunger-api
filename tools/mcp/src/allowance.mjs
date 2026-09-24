import { ApiError } from './api.mjs';

export const MEMBER_CALLS_PER_MINUTE = 30;

/** Per-member tool-call allowance: a UTC-day budget plus a short burst limit. Admins are never counted. */
export function memberAllowance(redis, { daily, perMinute = MEMBER_CALLS_PER_MINUTE, now = () => Date.now() }) {
  const dayKey = (userId) => `moh:mcp:member:calls:${userId}:${new Date(now()).toISOString().slice(0, 10)}`;
  const resetsAt = () => {
    const next = new Date(now());
    next.setUTCHours(24, 0, 0, 0);
    return next.toISOString();
  };
  const bump = async (key, ttl) => {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, ttl);
    return count;
  };
  return {
    daily,
    async usage(userId) {
      const used = Math.min(Number(await redis.get(dayKey(userId))) || 0, daily);
      return { used, limit: daily, remaining: daily - used, resetsAt: resetsAt() };
    },
    async consume(userId) {
      const minute = await bump(`moh:mcp:member:minute:${userId}:${Math.floor(now() / 60_000)}`, 60);
      if (minute > perMinute)
        throw new ApiError('Too many Men of Hunger requests in the last minute. Wait a moment, then try again.', 429);
      const used = await bump(dayKey(userId), 2 * 86400);
      if (used > daily)
        throw new ApiError(`You've reached today's Men of Hunger AI connection limit of ${daily} requests. It resets at midnight UTC.`, 429);
    },
  };
}
