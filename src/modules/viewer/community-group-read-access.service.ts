import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ViewerContextService } from './viewer-context.service';

/**
 * Community-group read access, shared between the HTTP read paths and the
 * websocket gateway's room-subscription gates. One predicate, two shapes:
 *
 *   - `assertCanRead` throws (HTTP semantics: 404 unknown group, 403 denied).
 *   - `filterReadableGroupIds` is a batch, non-throwing variant for the WS
 *     gateway (silently drops unreadable ids).
 *
 * Read rule: site admins always; active members always; open groups are
 * readable by any verified, signed-in user.
 */
@Injectable()
export class CommunityGroupReadAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly viewerContextService: ViewerContextService,
  ) {}

  async assertCanRead(viewerUserId: string | null, groupId: string): Promise<void> {
    const gid = (groupId ?? '').trim();
    if (!gid) throw new ForbiddenException('Group not found.');

    const group = await this.prisma.communityGroup.findFirst({
      where: { id: gid, deletedAt: null },
      select: { joinPolicy: true },
    });
    if (!group) throw new NotFoundException('Group not found.');

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    if (viewer?.siteAdmin) return;

    if (group.joinPolicy === 'open') {
      if (!viewerUserId) throw new ForbiddenException('Sign in to view this group.');
      if (!this.viewerContextService.isVerified(viewer)) {
        throw new ForbiddenException('Verify your account to view groups.');
      }
      return;
    }

    if (!viewerUserId) throw new ForbiddenException('This group is private.');
    const m = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: gid, userId: viewerUserId } },
      select: { status: true },
    });
    if (!m || m.status !== 'active') {
      throw new ForbiddenException('You are not a member of this group.');
    }
  }

  /**
   * Batch variant for the gateway: which of these group ids may the viewer read?
   * Viewer flags are passed explicitly because the gateway resolves them from
   * `client.data` (set at connection time) rather than a fresh DB read.
   */
  async filterReadableGroupIds(params: {
    viewerUserId: string | null;
    viewerIsAdmin: boolean;
    viewerIsVerified: boolean;
    groupIds: string[];
  }): Promise<Set<string>> {
    const ids = [...new Set(params.groupIds.map((id) => (id ?? '').trim()).filter(Boolean))];
    if (ids.length === 0) return new Set();

    const groups = await this.prisma.communityGroup.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, joinPolicy: true },
    });
    const policyById = new Map(groups.map((g) => [g.id, g.joinPolicy] as const));

    const memberships = params.viewerUserId
      ? await this.prisma.communityGroupMember.findMany({
          where: { userId: params.viewerUserId, groupId: { in: ids }, status: 'active' },
          select: { groupId: true },
        })
      : [];
    const activeGroupIds = new Set(memberships.map((m) => m.groupId));

    const readable = new Set<string>();
    for (const groupId of ids) {
      const policy = policyById.get(groupId);
      if (!policy) continue;
      const canRead =
        params.viewerIsAdmin ||
        activeGroupIds.has(groupId) ||
        (policy === 'open' && params.viewerIsVerified);
      if (canRead) readable.add(groupId);
    }
    return readable;
  }
}
