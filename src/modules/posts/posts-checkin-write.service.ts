import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { PostVisibility, Prisma } from "@prisma/client";
import { isUniqueViolation } from "../../common/prisma/errors";
import {
  easternDayKey,
  yesterdayEasternDayKey,
} from "../../common/time/eastern-day-key";
import {
  isCheckinOpen,
  CHECKIN_CLOSED_MESSAGE,
} from "../checkins/checkin-schedule";
import { computeCheckinRewards } from "../checkins/checkin-rewards";

export type CheckinReward = {
  coinsEarned: number;
  streakDays: number;
  multiplier: 1 | 2 | 3 | 4;
};

/** Checkin eligibility and rewards; awards always participate in the publication transaction. */
@Injectable()
export class PostsCheckinWriteService {
  validate(
    input: {
      visibility: PostVisibility;
      communityGroupId: string | null;
      parentId?: string | null;
      dayKey: string | null;
      prompt: string | null;
    },
    now: Date,
  ): void {
    if (!isCheckinOpen(now))
      throw new BadRequestException(CHECKIN_CLOSED_MESSAGE);
    if (input.communityGroupId) {
      throw new BadRequestException(
        "Check-ins cannot be posted inside a community group.",
      );
    }
    if (input.parentId)
      throw new BadRequestException("Check-ins must be top-level posts.");
    if (
      input.visibility !== "verifiedOnly" &&
      input.visibility !== "premiumOnly"
    ) {
      throw new BadRequestException(
        "Check-ins must be verified-only or premium-only.",
      );
    }
    const todayKey = easternDayKey(now);
    if (!input.dayKey || input.dayKey !== todayKey) {
      throw new BadRequestException("Invalid check-in day.");
    }
    if (!input.prompt)
      throw new BadRequestException("Check-in prompt is required.");
  }

  async award(
    tx: Prisma.TransactionClient,
    userId: string,
    now: Date,
  ): Promise<CheckinReward | null> {
    const todayKey = easternDayKey(now);
    const yesterdayKey = yesterdayEasternDayKey(now);
    const u = await tx.user.findUnique({
      where: { id: userId },
      select: {
        coins: true,
        checkinStreakDays: true,
        lastCheckinDayKey: true,
        longestStreakDays: true,
      },
    });
    if (!u) throw new NotFoundException("User not found.");
    const prevKey = u.lastCheckinDayKey ?? null;
    if (prevKey === todayKey) return null; // already awarded today
    const out = computeCheckinRewards({
      todayKey,
      yesterdayKey,
      lastCheckinDayKey: prevKey,
      currentStreakDays: u.checkinStreakDays ?? 0,
    });
    const nextLongest = Math.max(u.longestStreakDays ?? 0, out.nextStreakDays);
    // Atomic compare-and-swap: only apply when lastCheckinDayKey hasn't changed.
    // If another concurrent post already set it to todayKey, count === 0 and we bail.
    const claim = await tx.user.updateMany({
      where: { id: userId, lastCheckinDayKey: prevKey },
      data: {
        lastCheckinDayKey: todayKey,
        checkinStreakDays: out.nextStreakDays,
        longestStreakDays: nextLongest,
        coins: { increment: out.coinsAdd },
      },
    });
    if (claim.count === 0) return null; // concurrent post already awarded today — skip
    await tx.coinTransfer.create({
      data: {
        senderId: userId,
        recipientId: userId,
        kind: "streak_reward",
        amount: out.coinsAdd,
        note: `Day ${out.nextStreakDays} streak (${out.multiplier}x)`,
      },
    });
    return {
      coinsEarned: out.coinsAdd,
      streakDays: out.nextStreakDays,
      multiplier: out.multiplier,
    };
  }

  rethrowPublicationError(error: unknown, now: Date): never {
    if (!isCheckinOpen(now))
      throw new BadRequestException(CHECKIN_CLOSED_MESSAGE);
    if (isUniqueViolation(error))
      throw new BadRequestException("Already checked in today.");
    throw error;
  }
}
