import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../app/app-config.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';
import type { EmailCategory } from './email-delivery.types';
import type { EmailSendResult } from './providers/email-provider';

// Check and reserve in one Redis operation. The logical delivery owns its slot,
// so uncertain provider retries cannot consume another daily allowance.
export const RESERVE_EMAIL_BUDGET = `
if redis.call('EXISTS', KEYS[3]) == 1 then return 1 end
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count >= tonumber(ARGV[1]) then return 2 end
if ARGV[2] == '1' and redis.call('EXISTS', KEYS[2]) == 1 then return 3 end
redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
if ARGV[2] == '1' then redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[5]) end
redis.call('SET', KEYS[3], 'reserved', 'PX', ARGV[4])
return 1
`;
export const RECONCILE_EMAIL_BUDGET = `
local state = redis.call('GET', KEYS[3])
if not state then return 0 end
if ARGV[1] ~= 'rejected' then
  redis.call('SET', KEYS[3], ARGV[1], 'KEEPTTL')
  return 1
end
-- Once acceptance is uncertain or confirmed, never return this slot to the pool.
if state ~= 'reserved' then return 0 end
if tonumber(redis.call('GET', KEYS[1]) or '0') > 0 then redis.call('DECR', KEYS[1]) end
if ARGV[2] == '1' and redis.call('GET', KEYS[2]) == ARGV[3] then redis.call('DEL', KEYS[2]) end
redis.call('DEL', KEYS[3])
return 1
`;

type Reservation = { keys: [string, string, string]; userCap: boolean; deliveryId: string };
export type EmailBudgetResult = { allowed: true; reservation: Reservation } | { allowed: false; reason: string };

@Injectable()
export class EmailBudgetService {
  constructor(private readonly config: AppConfigService, private readonly redis: RedisService) {}

  async reserve(category: EmailCategory, userId: string | null, deliveryId: string): Promise<EmailBudgetResult> {
    const day = new Date().toISOString().slice(0, 10);
    const userCap = category === 'engagement' && !!userId;
    const reservation: Reservation = { deliveryId, userCap, keys: [
      category === 'broadcast' ? RedisKeys.emailBroadcastDailyCount(day) : RedisKeys.emailDailyCount(day),
      RedisKeys.emailLastEngagement(userId ?? deliveryId), RedisKeys.emailBudgetReservation(day, deliveryId),
    ] };
    const limit = category === 'broadcast' ? this.config.emailBroadcastDailyQuota() : category === 'transactional'
      ? this.config.emailDailyQuotaLimit() : Math.max(0, this.config.emailDailyQuotaLimit() - this.config.emailDailyVerificationReserve());
    try {
      const result = Number(await this.redis.raw().eval(RESERVE_EMAIL_BUDGET, 3, ...reservation.keys,
        limit, userCap ? '1' : '0', deliveryId, 48 * 60 * 60_000, 26 * 60 * 60_000));
      if (result === 1) return { allowed: true, reservation };
      if (result === 3) return { allowed: false, reason: 'email_per_user_engagement_cap' };
      if (result !== 2) return { allowed: false, reason: 'email_quota_unavailable' };
      return { allowed: false, reason: category === 'broadcast' ? 'email_quota_broadcast_limit' : category === 'transactional' ? 'email_quota_hard_limit' : 'email_quota_engagement_limit' };
    } catch {
      return { allowed: false, reason: 'email_quota_unavailable' };
    }
  }

  async reconcile(budget: EmailBudgetResult, result: EmailSendResult): Promise<void> {
    if (!budget.allowed) return;
    const { reservation } = budget;
    const state = result.sent ? 'accepted' : result.definitiveRejection ? 'rejected' : 'uncertain';
    await this.redis.raw().eval(RECONCILE_EMAIL_BUDGET, 3, ...reservation.keys, state, reservation.userCap ? '1' : '0', reservation.deliveryId);
  }

  async broadcastRemaining(): Promise<number> {
    try {
      const raw = await this.redis.getString(RedisKeys.emailBroadcastDailyCount(new Date().toISOString().slice(0, 10)));
      const count = Number(raw ?? '0');
      return Math.max(0, this.config.emailBroadcastDailyQuota() - (Number.isFinite(count) ? count : 0));
    } catch { return 0; }
  }
}
