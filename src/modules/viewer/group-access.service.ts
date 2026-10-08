import { Injectable } from '@nestjs/common';
import type { CommunityGroupMemberRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CommunityGroupReadAccessService } from './community-group-read-access.service';

import { assertGroupRole, findGroupMember, getGroupMemberOrThrow, GROUP_MANAGER_ROLES, type GroupMemberRow } from './group-membership.queries';

/** DI facade over group-membership.queries (single home for group role checks). */
@Injectable()
export class GroupAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readAccess: CommunityGroupReadAccessService,
  ) {}

  getMember(groupId: string, userId: string): Promise<GroupMemberRow | null> {
    return findGroupMember(this.prisma, groupId, userId);
  }

  getMemberOrThrow(groupId: string, userId: string, message?: string): Promise<GroupMemberRow> {
    return getGroupMemberOrThrow(this.prisma, groupId, userId, message);
  }

  assertRole(groupId: string, userId: string, roles: readonly CommunityGroupMemberRole[], message?: string): Promise<CommunityGroupMemberRole> {
    return assertGroupRole(this.prisma, groupId, userId, roles, message);
  }

  assertModOrOwner(groupId: string, userId: string): Promise<CommunityGroupMemberRole> {
    return assertGroupRole(this.prisma, groupId, userId, GROUP_MANAGER_ROLES);
  }

  /** HTTP read gate (404 unknown group, 403 denied). */
  assertCanRead(viewerUserId: string | null, groupId: string): Promise<void> {
    return this.readAccess.assertCanRead(viewerUserId, groupId);
  }
}
