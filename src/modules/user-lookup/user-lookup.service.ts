import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { viewerCanSeeMembers } from '../auth/member-visibility';

/** Narrow, typed single-user reads for controllers that must not touch Prisma directly. */
@Injectable()
export class UserLookupService {
  constructor(private readonly prisma: PrismaService) {}

  findById<S extends Prisma.UserSelect>(id: string, select: S) {
    return this.prisma.user.findUnique({ where: { id }, select }) as Promise<
      Prisma.UserGetPayload<{ select: S }> | null
    >;
  }

  findByIdOrThrow<S extends Prisma.UserSelect>(id: string, select: S) {
    return this.prisma.user.findUniqueOrThrow({ where: { id }, select }) as Promise<
      Prisma.UserGetPayload<{ select: S }>
    >;
  }

  viewerCanSeeMembers(viewerUserId: string | null | undefined): Promise<boolean> {
    return viewerCanSeeMembers(this.prisma, viewerUserId);
  }
}
