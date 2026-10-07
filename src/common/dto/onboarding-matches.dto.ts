import type { CommunityGroupShellDto } from './community-group.dto';
import type { UserListDto } from './user.dto';

export type OnboardingMatchesDto = {
  /** Open groups the member has not joined, closest to their interests first. */
  groups: CommunityGroupShellDto[];
  /** Members worth following, closest to their interests first. */
  people: UserListDto[];
  /** False when nothing in the member's answers could be matched and the lists are simply popular picks. */
  personalized: boolean;
};
