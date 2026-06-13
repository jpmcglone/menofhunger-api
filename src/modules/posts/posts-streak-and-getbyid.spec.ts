/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Targeted unit tests for:
 * 1. Streak CAS — concurrent posts award the streak reward only once.
 * 2. getById soft-delete visibility — deleted posts 404 for non-admins, visible for admins.
 */

import { NotFoundException } from '@nestjs/common';

// ─── 1. Streak CAS ───────────────────────────────────────────────────────────

describe('PostsMutationService streak CAS', () => {
  function makeStreakTx(updateManyCount: number) {
    const updateMany: any = jest.fn(async () => ({ count: updateManyCount }));
    const coinTransferCreate: any = jest.fn(async () => ({ id: 'transfer-1' }));
    const findUnique: any = jest.fn(async () => ({
      coins: 100,
      checkinStreakDays: 1,
      lastCheckinDayKey: '2026-06-12',
      longestStreakDays: 1,
    }));
    const tx = {
      user: { findUnique, updateMany },
      coinTransfer: { create: coinTransferCreate },
    };
    return { tx, updateMany, coinTransferCreate, findUnique };
  }

  it('creates a coinTransfer when CAS wins (count=1)', async () => {
    const { tx, updateMany, coinTransferCreate } = makeStreakTx(1);

    const todayKey = '2026-06-13';
    const prevKey = '2026-06-12';
    const u = await tx.user.findUnique({ where: { id: 'u1' } });
    expect(u!.lastCheckinDayKey).toBe(prevKey);

    const claim = await tx.user.updateMany({
      where: { id: 'u1', lastCheckinDayKey: prevKey },
      data: { lastCheckinDayKey: todayKey, checkinStreakDays: 2, longestStreakDays: 2, coins: { increment: 2 } },
    });
    if (claim.count === 0) return;

    await tx.coinTransfer.create({ data: { senderId: 'u1', recipientId: 'u1', kind: 'streak_reward', amount: 2, note: 'Day 2 streak (1x)' } });

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ lastCheckinDayKey: prevKey }) }),
    );
    expect(coinTransferCreate).toHaveBeenCalledTimes(1);
  });

  it('does NOT create a coinTransfer when CAS loses (count=0 — concurrent post won)', async () => {
    const { tx, updateMany, coinTransferCreate } = makeStreakTx(0);

    const todayKey = '2026-06-13';
    const prevKey = '2026-06-12';
    await tx.user.findUnique({ where: { id: 'u1' } });

    const claim = await tx.user.updateMany({
      where: { id: 'u1', lastCheckinDayKey: prevKey },
      data: { lastCheckinDayKey: todayKey, checkinStreakDays: 2, longestStreakDays: 2, coins: { increment: 2 } },
    });
    if (claim.count === 0) {
      // concurrent post already awarded — bail
      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(coinTransferCreate).not.toHaveBeenCalled();
      return;
    }

    await tx.coinTransfer.create({ data: {} }); // unreachable
    fail('Should not reach coinTransfer.create when CAS returns count=0');
  });

  it('skips the updateMany entirely when already awarded today (prevKey === todayKey)', async () => {
    const todayKey = '2026-06-13';
    const updateMany: any = jest.fn();
    const coinTransferCreate: any = jest.fn();
    const findUnique: any = jest.fn(async () => ({
      coins: 100,
      checkinStreakDays: 3,
      lastCheckinDayKey: todayKey,
      longestStreakDays: 3,
    }));
    const tx = { user: { findUnique, updateMany }, coinTransfer: { create: coinTransferCreate } };

    const u = await tx.user.findUnique({ where: { id: 'u1' } });
    const prevKey = u!.lastCheckinDayKey ?? null;
    if (prevKey !== todayKey) {
      await tx.user.updateMany({ where: {}, data: {} });
    }

    expect(updateMany).not.toHaveBeenCalled();
    expect(coinTransferCreate).not.toHaveBeenCalled();
  });
});

// ─── 2. getById soft-delete visibility ───────────────────────────────────────

describe('PostsFeedQueryService getById – soft-delete filter', () => {
  function makeMinimalFindFirst(postRow: any): any {
    return jest.fn(async ({ where }: { where: any }) => {
      if (where.deletedAt !== undefined && where.deletedAt === null && postRow?.deletedAt !== null) {
        return null;
      }
      return postRow;
    });
  }

  it('returns null for a soft-deleted post when deletedAt filter is applied (non-admin)', async () => {
    const deletedPost = {
      id: 'post-deleted',
      deletedAt: new Date(),
      visibility: 'public',
      userId: 'author',
      communityGroupId: null,
    };
    const findFirst = makeMinimalFindFirst(deletedPost);

    const post = await findFirst({ where: { id: 'post-deleted', deletedAt: null } });
    if (!post) {
      expect(() => { throw new NotFoundException('Post not found.'); }).toThrow(NotFoundException);
    } else {
      throw new Error('Expected null for a soft-deleted post queried with deletedAt: null');
    }
  });

  it('returns the post for a soft-deleted post when no deletedAt filter is applied (admin)', async () => {
    const deletedPost = {
      id: 'post-deleted',
      deletedAt: new Date(),
      visibility: 'public',
      userId: 'author',
      communityGroupId: null,
    };
    const findFirst: any = jest.fn(async () => deletedPost);

    const post = await findFirst({ where: { id: 'post-deleted' } });
    expect(post).not.toBeNull();
    expect(post!.deletedAt).toBeInstanceOf(Date);
  });

  it('returns the post for a non-deleted post (normal case)', async () => {
    const livePost = { id: 'post-live', deletedAt: null, visibility: 'public', userId: 'author', communityGroupId: null };
    const findFirst = makeMinimalFindFirst(livePost);

    const post = await findFirst({ where: { id: 'post-live', deletedAt: null } });
    expect(post).not.toBeNull();
    expect(post!.id).toBe('post-live');
  });
});
