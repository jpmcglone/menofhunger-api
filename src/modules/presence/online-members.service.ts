import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../app/app-config.service';
import { AccountSwitchService } from '../auth/auth-public-api';
import { MarvinBotIdentityService } from '../marvin/services/marvin-bot-identity.service';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceRedisReadService } from './presence-redis-read.service';

export type OnlineRoster = {
  /** Accounts with a live socket, oldest connection first (Redis order). */
  connectedIds: string[];
  /** Everyone shown online: connected accounts plus the pages they operate, real accounts only. */
  memberIds: string[];
  /** Displayed id → the connected account whose presence it inherits. */
  sourceByDisplayedId: Map<string, string>;
  /** Location of each member in `memberIds`, and of Marv when shown (null = none set). */
  locationById: Map<string, string | null>;
  /** Marv's id when he is shown as online (bot enabled), else null. Not in `memberIds`. */
  marvId: string | null;
  /** The one online number every surface shows: members plus Marv. */
  total: number;
};

/**
 * The single definition of "who is online", shared by /presence/online, /presence/online-page,
 * the realtime online feed (full and count-only), and the members map so they never disagree.
 */
@Injectable()
export class OnlineMembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRedis: PresenceRedisReadService,
    private readonly accountSwitch: AccountSwitchService,
    private readonly marvIdentity: MarvinBotIdentityService,
  ) {}

  /**
   * `viewerUserId` + `includeViewer: true` counts a signed-in requester whose socket has not
   * registered yet (the request itself proves they are here); `includeViewer: false` leaves
   * them out.
   */
  async resolve(opts: { viewerUserId?: string | null; includeViewer?: boolean } = {}): Promise<OnlineRoster> {
    const viewerUserId = opts.viewerUserId ?? null;
    let connectedIds = await this.presenceRedis.onlineUserIds();
    if (viewerUserId && opts.includeViewer === false) {
      connectedIds = connectedIds.filter((id) => id !== viewerUserId);
    } else if (viewerUserId && opts.includeViewer && !connectedIds.includes(viewerUserId)) {
      connectedIds = [viewerUserId, ...connectedIds];
    }

    const [expanded, marvId] = await Promise.all([
      this.accountSwitch.expandPresenceOnlineIds(connectedIds),
      this.appConfig.marvBot().enabled
        ? this.marvIdentity.getMarvUserId().catch(() => null)
        : Promise.resolve(null),
    ]);

    const candidates = expanded.displayedIds.filter((id) => id !== marvId);
    const lookup = marvId ? [...candidates, marvId] : candidates;
    const rows = lookup.length
      ? await this.prisma.user.findMany({
          where: { id: { in: lookup }, usernameIsSet: true, ...NOT_BANNED_USER_WHERE },
          select: { id: true, locationState: true },
        })
      : [];
    const locationById = new Map(rows.map((r) => [r.id, r.locationState ?? null]));
    const memberIds = candidates.filter((id) => locationById.has(id));

    return {
      connectedIds,
      memberIds,
      sourceByDisplayedId: expanded.sourceByDisplayedId,
      locationById,
      marvId: marvId ?? null,
      total: memberIds.length + (marvId ? 1 : 0),
    };
  }
}
