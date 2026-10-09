import { Injectable, Optional } from '@nestjs/common';
import { toCommunityGroupShellDto } from '../../common/dto/community-group.dto';
import type { OnboardingMatchesDto } from '../../common/dto/onboarding-matches.dto';
import { EmbeddingsService, userText } from '../embeddings/embeddings.service';
import { FollowsService } from '../follows/follows.service';
import { PrismaService } from '../prisma/prisma.service';
import { JevTopicsService } from '../typesafe/jev-topics.service';
import { listActiveOrPendingGroupIdsForUser } from '../viewer/group-membership.queries';
import { NOT_DELETED } from '../../common/prisma/where';

const GROUP_LIMIT = 6;
const PEOPLE_LIMIT = 6;
const GROUP_MAX_DISTANCE = 0.7;
/** People who share the topics Jev read from the member's own words; the rest come from meaning. */
const TOPIC_PEOPLE_SLOTS = 2;

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
    @Optional() private readonly jevTopics?: JevTopicsService,
  ) {}

  async matches(userId: string, intent: string): Promise<OnboardingMatchesDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { interests: true, bio: true } });
    const text = userText([intent.trim(), user?.bio ?? ''].filter(Boolean).join('\n'), user?.interests ?? []);
    const vector = text ? await this.embeddings.embedQuery(text) : null;

    const mineIds = await listActiveOrPendingGroupIdsForUser(this.prisma, userId);

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
        where: { ...NOT_DELETED, joinPolicy: 'open', id: { notIn: [...mineIds, ...groupIds] } },
        orderBy: [{ isFeatured: 'desc' }, { memberCount: 'desc' }, { createdAt: 'desc' }],
        take: GROUP_LIMIT - groupIds.length,
        select: { id: true },
      });
      groupIds.push(...filler.map((g) => g.id));
    }
    const groupRows = groupIds.length ? await this.prisma.communityGroup.findMany({ where: { id: { in: groupIds } } }) : [];
    const groupById = new Map(groupRows.map((g) => [g.id, g] as const));
    const groups = groupIds.map((id) => groupById.get(id)).filter((g): g is NonNullable<typeof g> => Boolean(g)).map((g) => toCommunityGroupShellDto(g, null));

    const [meaningPeople, topicPeople] = await Promise.all([
      vector ? this.follows.recommendUsersByMeaning({ viewerUserId: userId, vector, limit: PEOPLE_LIMIT }).catch(() => null) : null,
      this.peopleByStatedTopics(userId, intent),
    ]);
    // Members who share the topics Jev read from what they said, blended in beside the meaning matches.
    const meaning = meaningPeople ?? [];
    const haveMeaning = new Set(meaning.map((p) => p.id));
    const topical = topicPeople.filter((p) => !haveMeaning.has(p.id)).slice(0, TOPIC_PEOPLE_SLOTS);
    let people = [...meaning.slice(0, PEOPLE_LIMIT - topical.length), ...topical, ...meaning.slice(PEOPLE_LIMIT - topical.length)].slice(0, PEOPLE_LIMIT);
    const personalizedPeople = people.length;
    if (people.length < PEOPLE_LIMIT) {
      const fallback = await this.follows.recommendUsersToFollow({ viewerUserId: userId, limit: PEOPLE_LIMIT }).catch(() => ({ users: [] }));
      const have = new Set(people.map((p) => p.id));
      people = [...people, ...fallback.users.filter((u) => !have.has(u.id))].slice(0, PEOPLE_LIMIT);
    }

    return { groups, people: people, personalized: personalizedGroups + personalizedPeople > 0 };
  }
  /** Public members whose interests overlap the topics Jev finds in what the member typed. Empty when Jev is unavailable. */
  private async peopleByStatedTopics(userId: string, intent: string) {
    const text = intent.trim();
    if (!this.jevTopics || text.length < 3) return [];
    const topics = await this.jevTopics.topicsFor(text, 'search query').catch(() => null);
    if (!topics?.length) return [];
    const res = await this.follows.recommendArenaUsersToFollow({ viewerUserId: userId, interestKeys: topics, limit: PEOPLE_LIMIT }).catch(() => null);
    return res?.users ?? [];
  }
}
