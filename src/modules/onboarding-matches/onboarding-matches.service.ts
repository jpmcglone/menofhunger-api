import { Injectable } from '@nestjs/common';
import { toCommunityGroupShellDto } from '../../common/dto/community-group.dto';
import type { UserListDto } from '../../common/dto/user.dto';
import type { OnboardingMatchesDto } from '../../common/dto/onboarding-matches.dto';
import { EmbeddingsService, userText } from '../embeddings/embeddings.service';
import { FollowsService } from '../follows/follows.service';
import { PrismaService } from '../prisma/prisma.service';

const GROUP_LIMIT = 6;
const PEOPLE_LIMIT = 6;
const GROUP_MAX_DISTANCE = 0.7;

/**
 * First-run suggestions from what a member says they want. Meaning-based when vectors are
 * available; otherwise the same popular and mutual-graph picks members would see anyway.
 * Only open groups and public member profiles are considered, so nothing private leaks.
 */
@Injectable()
export class OnboardingMatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingsService,
    private readonly follows: FollowsService,
  ) {}

  async matches(userId: string, intent: string): Promise<OnboardingMatchesDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { interests: true, bio: true } });
    const text = userText([intent.trim(), user?.bio ?? ''].filter(Boolean).join('\n'), user?.interests ?? []);
    const vector = text ? await this.embeddings.embedQuery(text) : null;

    const mine = await this.prisma.communityGroupMember.findMany({
      where: { userId, status: { in: ['active', 'pending'] } },
      select: { groupId: true },
    });
    const mineIds = mine.map((m) => m.groupId);

    const groupIds: string[] = [];
    if (vector) {
      const near = await this.embeddings
        .nearestGroups(vector, { limit: GROUP_LIMIT, maxDistance: GROUP_MAX_DISTANCE, excludeGroupIds: mineIds })
        .catch(() => []);
      groupIds.push(...near.map((r) => r.id));
    }
    const personalizedGroups = groupIds.length;
    if (groupIds.length < GROUP_LIMIT) {
      const filler = await this.prisma.communityGroup.findMany({
        where: { deletedAt: null, joinPolicy: 'open', id: { notIn: [...mineIds, ...groupIds] } },
        orderBy: [{ isFeatured: 'desc' }, { memberCount: 'desc' }, { createdAt: 'desc' }],
        take: GROUP_LIMIT - groupIds.length,
        select: { id: true },
      });
      groupIds.push(...filler.map((g) => g.id));
    }
    const groupRows = groupIds.length ? await this.prisma.communityGroup.findMany({ where: { id: { in: groupIds } } }) : [];
    const groupById = new Map(groupRows.map((g) => [g.id, g] as const));
    const groups = groupIds.map((id) => groupById.get(id)).filter((g): g is NonNullable<typeof g> => Boolean(g)).map((g) => toCommunityGroupShellDto(g, null));

    let people = vector ? ((await this.follows.recommendUsersByMeaning({ viewerUserId: userId, vector, limit: PEOPLE_LIMIT }).catch(() => null)) ?? []) : [];
    const personalizedPeople = people.length;
    if (people.length < PEOPLE_LIMIT) {
      const fallback = await this.follows.recommendUsersToFollow({ viewerUserId: userId, limit: PEOPLE_LIMIT }).catch(() => ({ users: [] }));
      const have = new Set(people.map((p) => p.id));
      people = [...people, ...fallback.users.filter((u) => !have.has(u.id))].slice(0, PEOPLE_LIMIT);
    }

    return { groups, people: people as unknown as UserListDto[], personalized: personalizedGroups + personalizedPeople > 0 };
  }
}
