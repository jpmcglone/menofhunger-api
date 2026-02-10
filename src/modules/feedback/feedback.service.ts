import type { FeedbackCategory, FeedbackStatus, Prisma } from '@prisma/client';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    category: FeedbackCategory;
    email: string | null;
    subject: string;
    details: string;
    userId?: string | null;
    submitterIp?: string | null;
  }) {
    const submitterIp = (input.submitterIp ?? '').trim() || null;

    const throwRateLimit = () => {
      throw new HttpException(
        { message: 'Too many feedback submissions. Please try again later.', error: 'feedback_rate_limit' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    };

    // Rate limiting (DB-backed):
    // - Anonymous: 3 submissions per hour per IP.
    // - Logged-in but unverified: 5 submissions per hour per user.
    //
    // Verified/premium/admin users are not constrained here (global throttling still applies).
    const windowMs = 60 * 60 * 1000;
    const since = new Date(Date.now() - windowMs);

    if (!input.userId) {
      if (submitterIp) {
        const count = await this.prisma.feedback.count({
          where: { submitterIp, createdAt: { gt: since } },
        });
        if (count >= 3) {
          throwRateLimit();
        }
      } else {
        // No IP available: apply a conservative global cap.
        const count = await this.prisma.feedback.count({
          where: { userId: null, createdAt: { gt: since } },
        });
        if (count >= 20) {
          throwRateLimit();
        }
      }
    } else {
      const user = await this.prisma.user.findUnique({
        where: { id: input.userId },
        select: { verifiedStatus: true, premium: true, premiumPlus: true, siteAdmin: true },
      });
      const isUnverified = !user || user.verifiedStatus === 'none';
      const isExempt = Boolean(user?.siteAdmin || user?.premium || user?.premiumPlus || (user?.verifiedStatus && user.verifiedStatus !== 'none'));
      if (isUnverified && !isExempt) {
        const count = await this.prisma.feedback.count({
          where: { userId: input.userId, createdAt: { gt: since } },
        });
        if (count >= 5) {
          throwRateLimit();
        }
      }
    }

    return await this.prisma.feedback.create({
      data: {
        category: input.category,
        email: input.email,
        subject: input.subject,
        details: input.details,
        submitterIp,
        ...(input.userId ? { user: { connect: { id: input.userId } } } : {}),
      },
    });
  }

  async listAdmin(params: {
    limit: number;
    cursor: string | null;
    status?: FeedbackStatus;
    category?: FeedbackCategory;
    q?: string;
  }) {
    const cursorWhere = await createdAtIdCursorWhere({
      cursor: params.cursor,
      lookup: async (id) =>
        this.prisma.feedback.findUnique({
          where: { id },
          select: { id: true, createdAt: true },
        }),
    });

    const whereParts: Prisma.FeedbackWhereInput[] = [];
    if (cursorWhere) whereParts.push(cursorWhere);
    if (params.status) whereParts.push({ status: params.status });
    if (params.category) whereParts.push({ category: params.category });

    const q = (params.q ?? '').trim();
    if (q) {
      whereParts.push({
        OR: [
          { subject: { contains: q, mode: 'insensitive' } },
          { details: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      });
    }

    const where = whereParts.length ? { AND: whereParts } : undefined;

    const rows = await this.prisma.feedback.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: params.limit + 1,
      include: {
        user: { select: { id: true, username: true, name: true, avatarKey: true, avatarUpdatedAt: true } },
      },
    });

    const slice = rows.slice(0, params.limit);
    const nextCursor = rows.length > params.limit ? slice[slice.length - 1]?.id ?? null : null;

    return { rows: slice, nextCursor };
  }

  async updateAdmin(id: string, input: { status?: FeedbackStatus; adminNote?: string | null }) {
    return await this.prisma.feedback.update({
      where: { id },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.adminNote !== undefined ? { adminNote: input.adminNote } : {}),
      },
      include: {
        user: { select: { id: true, username: true, name: true, avatarKey: true, avatarUpdatedAt: true } },
      },
    });
  }
}
