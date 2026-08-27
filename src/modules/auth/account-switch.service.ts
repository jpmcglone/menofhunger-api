import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AccountKind, Prisma } from '@prisma/client';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { AuthService } from './auth.service';
import { toUserDto } from '../../common/dto/user.dto';
import { USER_DTO_SELECT } from '../../common/prisma-selects/user.select';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import type { AccountSwitchDto, SwitchableAccountDto } from '../../common/dto/auth.dto';

@Injectable()
export class AccountSwitchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly auth: AuthService,
  ) {}

  private get publicBaseUrl(): string | null {
    return this.appConfig.r2()?.publicBaseUrl ?? null;
  }

  async describe(operatedByUserId: string | null | undefined): Promise<AccountSwitchDto | null> {
    const id = String(operatedByUserId ?? '').trim();
    if (!id) return null;
    const operator = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, username: true, name: true, avatarKey: true, avatarUpdatedAt: true },
    });
    if (!operator) return null;
    return {
      operatorUserId: operator.id,
      operatorUsername: operator.username,
      operatorName: operator.name,
      operatorAvatarUrl: publicAssetUrl({
        publicBaseUrl: this.publicBaseUrl,
        key: operator.avatarKey,
        updatedAt: operator.avatarUpdatedAt,
      }),
    };
  }

  /**
   * Person driving this session: the signed-in person, or the operator when
   * acting as a page. Null if the session is a page with no operator (shouldn't happen).
   */
  resolveOperatorId(session: {
    userId: string;
    accountKind?: AccountKind | string | null;
    operatedByUserId?: string | null;
  }): string | null {
    if (session.operatedByUserId) return session.operatedByUserId;
    if (session.accountKind === AccountKind.page) return null;
    return session.userId;
  }

  /** Person accounts that operate this page. Empty when `userId` is a person. */
  async listOperatorIdsForPage(pageUserId: string): Promise<string[]> {
    const id = String(pageUserId ?? '').trim();
    if (!id) return [];
    const rows = await this.prisma.userPageOperator.findMany({
      where: { pageUserId: id },
      select: { operatorUserId: true },
    });
    return rows.map((r) => r.operatorUserId);
  }

  /** Pages this person operates. */
  async listPageUserIdsForOperator(operatorUserId: string): Promise<string[]> {
    const id = String(operatorUserId ?? '').trim();
    if (!id) return [];
    const rows = await this.prisma.userPageOperator.findMany({
      where: { operatorUserId: id },
      select: { pageUserId: true },
    });
    return rows.map((r) => r.pageUserId);
  }

  /**
   * Device-token owners for a recipient. Pages never own tokens — their operators do.
   */
  async listTokenOwnerIds(userId: string): Promise<string[]> {
    const id = String(userId ?? '').trim();
    if (!id) return [];
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { accountKind: true },
    });
    if (user?.accountKind === AccountKind.page) return this.listOperatorIdsForPage(id);
    return [id];
  }

  /**
   * Operator + every page they operate. For a page, unions every operator's cluster
   * so a session signed in as either identity hears switcher patches.
   */
  async listClusterUserIds(userId: string): Promise<string[]> {
    const id = String(userId ?? '').trim();
    if (!id) return [];
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { accountKind: true },
    });
    if (!user) return [];
    const ids = new Set<string>();
    const operators =
      user.accountKind === AccountKind.page ? await this.listOperatorIdsForPage(id) : [id];
    for (const operatorId of operators) {
      ids.add(operatorId);
      for (const pageId of await this.listPageUserIdsForOperator(operatorId)) ids.add(pageId);
    }
    return [...ids];
  }

  /**
   * Presence cluster: a person plus every page they operate. A connected page
   * maps to its operators and those operators' other pages, so switching
   * identity does not drop anyone from Online now.
   */
  async presenceClusterByUserId(userIds: string[]): Promise<Map<string, string[]>> {
    const ids = [...new Set(userIds.map((id) => String(id ?? '').trim()).filter(Boolean))];
    const out = new Map<string, string[]>();
    if (ids.length === 0) return out;

    const asPage = await this.prisma.userPageOperator.findMany({
      where: { pageUserId: { in: ids } },
      select: { operatorUserId: true, pageUserId: true },
    });
    const operatorIds = new Set(ids);
    for (const row of asPage) operatorIds.add(row.operatorUserId);

    const asOperator = await this.prisma.userPageOperator.findMany({
      where: { operatorUserId: { in: [...operatorIds] } },
      select: { operatorUserId: true, pageUserId: true },
    });
    const pagesByOperator = new Map<string, string[]>();
    const operatorsByPage = new Map<string, string[]>();
    for (const row of asOperator) {
      const pages = pagesByOperator.get(row.operatorUserId) ?? [];
      pages.push(row.pageUserId);
      pagesByOperator.set(row.operatorUserId, pages);
      const operators = operatorsByPage.get(row.pageUserId) ?? [];
      operators.push(row.operatorUserId);
      operatorsByPage.set(row.pageUserId, operators);
    }

    for (const id of ids) {
      const displayed = new Set<string>([id]);
      const operators = operatorsByPage.get(id);
      if (operators && operators.length > 0) {
        for (const operatorId of operators) {
          displayed.add(operatorId);
          for (const pageId of pagesByOperator.get(operatorId) ?? []) displayed.add(pageId);
        }
      } else {
        for (const pageId of pagesByOperator.get(id) ?? []) displayed.add(pageId);
      }
      out.set(id, [...displayed]);
    }
    return out;
  }

  /**
   * Expand actually-connected sockets into the identities that should appear
   * online. `sourceByDisplayedId` points each displayed id at a connected
   * member so idle/platforms/lastConnectAt can be inherited.
   */
  async expandPresenceOnlineIds(connectedIds: string[]): Promise<{
    displayedIds: string[];
    sourceByDisplayedId: Map<string, string>;
  }> {
    const connected = [...new Set(connectedIds.map((id) => String(id ?? '').trim()).filter(Boolean))];
    const sourceByDisplayedId = new Map<string, string>();
    for (const id of connected) sourceByDisplayedId.set(id, id);
    if (connected.length === 0) return { displayedIds: [], sourceByDisplayedId };

    const clusters = await this.presenceClusterByUserId(connected);
    for (const connectedId of connected) {
      for (const displayedId of clusters.get(connectedId) ?? [connectedId]) {
        if (!sourceByDisplayedId.has(displayedId)) sourceByDisplayedId.set(displayedId, connectedId);
      }
    }
    return { displayedIds: [...sourceByDisplayedId.keys()], sourceByDisplayedId };
  }

  /** Bell + groups + chat unread for one identity (switcher row). */
  async unreadBadgeCountForUser(userId: string): Promise<number> {
    const counts = await this.unreadBadgeCounts([userId]);
    return counts.get(userId) ?? 0;
  }

  private async unreadBadgeCounts(userIds: string[]): Promise<Map<string, number>> {
    const ids = [...new Set(userIds.map((id) => String(id ?? '').trim()).filter(Boolean))];
    const out = new Map<string, number>();
    if (ids.length === 0) return out;

    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        undeliveredNotificationCount: true,
        undeliveredGroupPostCount: true,
      },
    });
    const chatByUser = await this.messageUnreadByUserIds(ids);
    for (const user of users) {
      const bell = Math.max(0, Math.floor(Number(user.undeliveredNotificationCount) || 0));
      const groups = Math.max(0, Math.floor(Number(user.undeliveredGroupPostCount) || 0));
      const chat = chatByUser.get(user.id) ?? 0;
      out.set(user.id, bell + groups + chat);
    }
    return out;
  }

  private async messageUnreadByUserIds(userIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (userIds.length === 0) return out;
    const rows = await this.prisma.$queryRaw<Array<{ userId: string; count: bigint | number }>>(
      Prisma.sql`
        SELECT mp."userId" AS "userId", COUNT(m.id)::int AS count
        FROM "MessageParticipant" mp
        INNER JOIN "Message" m ON m."conversationId" = mp."conversationId"
        WHERE mp."userId" IN (${Prisma.join(userIds)})
          AND m."senderId" <> mp."userId"
          AND (mp."lastReadAt" IS NULL OR m."createdAt" > mp."lastReadAt")
        GROUP BY mp."userId"
      `,
    );
    for (const row of rows) {
      out.set(row.userId, Math.max(0, Math.floor(Number(row.count) || 0)));
    }
    return out;
  }

  async listAccounts(params: {
    effectiveUserId: string;
    operatedByUserId: string | null;
    accountKind: AccountKind | string;
  }): Promise<SwitchableAccountDto[]> {
    const operatorId = this.resolveOperatorId({
      userId: params.effectiveUserId,
      accountKind: params.accountKind,
      operatedByUserId: params.operatedByUserId,
    });
    if (!operatorId) {
      throw new BadRequestException('This session cannot switch accounts.');
    }

    const [operator, operated] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: operatorId },
        select: {
          id: true,
          username: true,
          name: true,
          avatarKey: true,
          avatarUpdatedAt: true,
          accountKind: true,
          isOrganization: true,
          bannedAt: true,
        },
      }),
      this.prisma.userPageOperator.findMany({
        where: { operatorUserId: operatorId },
        orderBy: { createdAt: 'asc' },
        include: {
          page: {
            select: {
              id: true,
              username: true,
              name: true,
              avatarKey: true,
              avatarUpdatedAt: true,
              accountKind: true,
              isOrganization: true,
              bannedAt: true,
            },
          },
        },
      }),
    ]);
    if (!operator || operator.bannedAt) {
      throw new UnauthorizedException('Your account is no longer available.');
    }

    const rows = [operator, ...operated.map((r) => r.page).filter((p) => !p.bannedAt)];
    const unreadByUser = await this.unreadBadgeCounts(rows.map((row) => row.id));
    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      name: row.name,
      avatarUrl: publicAssetUrl({
        publicBaseUrl: this.publicBaseUrl,
        key: row.avatarKey,
        updatedAt: row.avatarUpdatedAt,
      }),
      accountKind: row.accountKind,
      isOrganization: row.isOrganization,
      isCurrent: row.id === params.effectiveUserId,
      unreadBadgeCount: unreadByUser.get(row.id) ?? 0,
    }));
  }

  async switchTo(params: {
    currentUserId: string;
    operatedByUserId: string | null;
    impersonatedByUserId: string | null;
    accountKind: AccountKind | string;
    targetUserId: string;
    currentToken: string | undefined;
    res: Response;
  }) {
    if (params.impersonatedByUserId) {
      throw new ForbiddenException('Exit impersonation before switching accounts.');
    }

    const targetId = String(params.targetUserId ?? '').trim();
    if (!targetId) throw new BadRequestException('Choose an account to switch to.');

    const operatorId = this.resolveOperatorId({
      userId: params.currentUserId,
      accountKind: params.accountKind,
      operatedByUserId: params.operatedByUserId,
    });
    if (!operatorId) {
      throw new BadRequestException('This session cannot switch accounts.');
    }

    const allowed = await this.canOperate(operatorId, targetId);
    if (!allowed) {
      throw new ForbiddenException('You cannot switch to that account.');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { ...USER_DTO_SELECT, bannedAt: true },
    });
    if (!target) throw new NotFoundException('Account not found.');
    if (target.bannedAt) throw new BadRequestException('That account is banned.');

    await this.auth.revokeSessionToken(params.currentToken);

    const operatedByUserId = targetId === operatorId ? null : operatorId;
    await this.auth.createSessionForUser(targetId, params.res, { operatedByUserId });

    return { user: toUserDto(target, this.publicBaseUrl) };
  }

  private async canOperate(operatorId: string, targetId: string): Promise<boolean> {
    if (operatorId === targetId) return true;
    const row = await this.prisma.userPageOperator.findUnique({
      where: { operatorUserId_pageUserId: { operatorUserId: operatorId, pageUserId: targetId } },
      select: { pageUserId: true },
    });
    return Boolean(row);
  }
}
