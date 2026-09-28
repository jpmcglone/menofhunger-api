import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ActivationCompletionDto, ActivationDto } from '../../common/dto/activation.dto';
import { UsersMeRealtimeService } from './users-me-realtime.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ActivationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: UsersMeRealtimeService,
  ) {}

  async claimCompletion(userId: string): Promise<ActivationCompletionDto> {
    const progress = await this.get(userId);
    if (progress.completionSeen || progress.phase !== 'approved'
      || !progress.contributed || !progress.replied || !progress.returned) return { present: false };
    // Compare-and-set makes simultaneous web/iOS requests mutually exclusive.
    const claimed = await this.prisma.user.updateMany({
      where: { id: userId, activationCelebratedAt: null },
      data: { activationCelebratedAt: new Date() },
    });
    if (claimed.count === 1) await this.realtime.emitMeUpdated(userId, 'activation-completed');
    return { present: claimed.count === 1 };
  }

  async get(userId: string): Promise<ActivationDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId }, select: { verifiedStatus: true, verifiedAt: true, activationCelebratedAt: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    const approved = user.verifiedStatus !== 'none';
    const [request, follow] = await Promise.all([
      this.prisma.verificationRequest.findFirst({
        where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { status: true },
      }),
      // These two accounts are automatically followed at signup. Discovery means
      // choosing someone beyond the starter accounts; never count seeded follows.
      this.prisma.follow.findFirst({ where: {
        followerId: userId, following: { isBot: false, NOT: [
          { username: { equals: 'john', mode: 'insensitive' } },
          { username: { equals: 'menofhunger', mode: 'insensitive' } },
        ] },
      }, select: { id: true } }),
    ]);
    const result: ActivationDto = {
      completionSeen: Boolean(user.activationCelebratedAt),
      phase: approved ? 'approved' : 'before_approval',
      verificationRequested: approved || request?.status === 'pending' || request?.status === 'approved',
      verificationPending: !approved && request?.status === 'pending',
      followed: Boolean(follow), contributed: false, replied: false, returned: false,
    };
    // Legacy approved accounts without a timestamp count their existing activity.
    if (!approved) return result;
    const where: Prisma.PostWhereInput = {
      userId, deletedAt: null, isDraft: false, scheduledAt: null,
      visibility: { not: 'onlyMe' }, kind: { in: ['regular', 'checkin'] },
      ...(user.verifiedAt ? { createdAt: { gte: user.verifiedAt } } : {}),
    };
    const [first, reply] = await Promise.all([
      this.prisma.post.findFirst({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { createdAt: true } }),
      this.prisma.post.findFirst({ where: { ...where, parent: { userId: { not: userId }, deletedAt: null, user: { isBot: false } } }, select: { id: true } }),
    ]);
    result.contributed = Boolean(first);
    result.replied = Boolean(reply);
    if (first) {
      const nextDay = new Date(first.createdAt);
      nextDay.setUTCHours(24, 0, 0, 0);
      result.returned = Boolean(await this.prisma.post.findFirst({
        where: { ...where, createdAt: { gte: nextDay } }, select: { id: true },
      }));
    }
    return result;
  }
}
