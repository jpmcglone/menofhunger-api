import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Narrow, typed single-user reads for controllers that must not touch Prisma directly. */
@Injectable()
export class UserLookupService {
  constructor(private readonly prisma: PrismaService) {}

  findById<S extends Prisma.UserSelect>(id: string, select: S) {
    return this.prisma.user.findUnique({ where: { id }, select }) as Promise<
      Prisma.UserGetPayload<{ select: S }> | null
    >;
  }
}
