import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountKind, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { EntitlementService } from '../billing/entitlement.service';
import { validateUsername } from '../users/users.utils';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { AppConfigService } from '../app/app-config.service';
import {
  PAGE_BIRTHDATE,
  PAGE_HEARD_ABOUT_US,
  PAGE_ONBOARDING_INTERESTS,
} from './pages.constants';

export type PageOperatorDto = {
  id: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
};

export type OperatedPageDto = {
  id: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
  accountKind: AccountKind;
  isOrganization: boolean;
};

export type PageUserDto = {
  id: string;
  username: string | null;
  name: string | null;
  accountKind: AccountKind;
  isOrganization: boolean;
  operators: PageOperatorDto[];
};

@Injectable()
export class PagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly entitlements: EntitlementService,
    private readonly appConfig: AppConfigService,
  ) {}

  private get publicBaseUrl(): string | null {
    return this.appConfig.r2()?.publicBaseUrl ?? null;
  }

  async createPage(params: {
    username: string;
    name: string;
    isOrganization: boolean;
    operatorUserId: string;
  }): Promise<PageUserDto> {
    const parsed = validateUsername(params.username);
    if (!parsed.ok) throw new BadRequestException(parsed.error);

    const name = params.name.trim();
    if (!name) throw new BadRequestException('Name is required.');
    if (name.length > 50) throw new BadRequestException('Name must be 50 characters or fewer.');

    const operator = await this.requirePersonOperator(params.operatorUserId);

    if (params.isOrganization && (!operator.premium || operator.verifiedStatus === 'none')) {
      throw new BadRequestException('Organization pages need a verified premium operator.');
    }

    const taken = await this.prisma.user.findFirst({
      where: { username: { equals: parsed.username, mode: 'insensitive' } },
      select: { id: true },
    });
    if (taken) throw new ConflictException('That username is already taken.');

    const now = new Date();
    let pageId: string;
    try {
      const page = await this.prisma.user.create({
        data: {
          accountKind: AccountKind.page,
          phone: null,
          username: parsed.username,
          usernameIsSet: true,
          name,
          isOrganization: params.isOrganization,
          menOnlyConfirmed: true,
          birthdate: PAGE_BIRTHDATE,
          interests: PAGE_ONBOARDING_INTERESTS,
          heardAboutUs: PAGE_HEARD_ABOUT_US,
          verifiedStatus: 'manual',
          verifiedAt: now,
          premium: true,
        },
        select: { id: true },
      });
      pageId = page.id;
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('That username is already taken.');
      }
      throw err;
    }

    await this.linkOperator(pageId, operator.id, params.isOrganization);
    await this.entitlements.recomputeAndApply(pageId);

    return this.getPageOrThrow(pageId);
  }

  async convertToPage(sourceUserId: string, operatorUserId: string): Promise<PageUserDto> {
    const source = await this.prisma.user.findUnique({
      where: { id: sourceUserId },
      select: {
        id: true,
        phone: true,
        accountKind: true,
        siteAdmin: true,
        isOrganization: true,
        bannedAt: true,
        username: true,
      },
    });
    if (!source) throw new NotFoundException('User not found.');
    if (source.accountKind === AccountKind.page) {
      throw new BadRequestException('This account is already a page.');
    }
    if (source.siteAdmin) {
      throw new BadRequestException('Site admin accounts cannot be converted to pages.');
    }
    if (source.id === operatorUserId) {
      throw new BadRequestException('A user cannot operate themselves as a page.');
    }

    const operatedCount = await this.prisma.userPageOperator.count({
      where: { operatorUserId: source.id },
    });
    if (operatedCount > 0) {
      throw new BadRequestException('Reassign this account’s pages before converting it.');
    }

    const operator = await this.requirePersonOperator(operatorUserId);

    if (source.isOrganization && (!operator.premium || operator.verifiedStatus === 'none')) {
      throw new BadRequestException('Organization pages need a verified premium operator.');
    }

    const now = new Date();
    const releasedPhone = source.phone;

    await this.prisma.user.update({
      where: { id: source.id },
      data: {
        accountKind: AccountKind.page,
        phone: null,
        ...(source.isOrganization
          ? { verifiedStatus: 'manual' as const, verifiedAt: now, premium: true }
          : {}),
      },
    });
    await this.releaseParkedPhone({ userId: source.id, phone: releasedPhone });

    await this.auth.revokeAllSessionsForUser(source.id);
    await this.linkOperator(source.id, operator.id, source.isOrganization);
    await this.entitlements.recomputeAndApply(source.id);

    return this.getPageOrThrow(source.id);
  }

  async addOperator(pageUserId: string, operatorUserId: string): Promise<PageOperatorDto> {
    const page = await this.requirePage(pageUserId);
    const operator = await this.requirePersonOperator(operatorUserId);
    if (page.id === operator.id) {
      throw new BadRequestException('A user cannot operate themselves as a page.');
    }
    await this.linkOperator(page.id, operator.id, page.isOrganization);
    await this.releasePagePhone(page.id);
    await this.entitlements.recomputeAndApply(page.id);
    return this.toOperatorDto(operator);
  }

  async removeOperator(pageUserId: string, operatorUserId: string): Promise<void> {
    const deleted = await this.prisma.userPageOperator.deleteMany({
      where: { pageUserId, operatorUserId },
    });
    if (deleted.count === 0) throw new NotFoundException('Operator not found.');
    await this.entitlements.recomputeAndApply(pageUserId);
  }

  async listOperators(pageUserId: string): Promise<PageOperatorDto[]> {
    await this.requirePage(pageUserId);
    await this.releasePagePhone(pageUserId);
    const rows = await this.prisma.userPageOperator.findMany({
      where: { pageUserId },
      orderBy: { createdAt: 'asc' },
      include: {
        operator: {
          select: { id: true, username: true, name: true, avatarKey: true, avatarUpdatedAt: true },
        },
      },
    });
    return rows.map((r) => this.toOperatorDto(r.operator));
  }

  async listOperatedPages(operatorUserId: string): Promise<OperatedPageDto[]> {
    const rows = await this.prisma.userPageOperator.findMany({
      where: { operatorUserId },
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
          },
        },
      },
    });
    return rows.map((r) => ({
      id: r.page.id,
      username: r.page.username,
      name: r.page.name,
      avatarUrl: publicAssetUrl({
        publicBaseUrl: this.publicBaseUrl,
        key: r.page.avatarKey,
        updatedAt: r.page.avatarUpdatedAt,
      }),
      accountKind: r.page.accountKind,
      isOrganization: r.page.isOrganization,
    }));
  }

  async getPageOrThrow(pageUserId: string): Promise<PageUserDto> {
    const page = await this.requirePage(pageUserId);
    const operators = await this.listOperators(pageUserId);
    return {
      id: page.id,
      username: page.username,
      name: page.name,
      accountKind: page.accountKind,
      isOrganization: page.isOrganization,
      operators,
    };
  }

  /** Pages do not own a login phone. Drop it and any leftover park row. */
  private async releasePagePhone(pageUserId: string): Promise<void> {
    const page = await this.prisma.user.findUnique({
      where: { id: pageUserId },
      select: { id: true, phone: true },
    });
    if (!page) return;
    if (page.phone) {
      await this.prisma.user.update({
        where: { id: page.id },
        data: { phone: null },
      });
    }
    await this.releaseParkedPhone({ userId: page.id, phone: page.phone });
  }

  private async releaseParkedPhone(params: { userId: string; phone: string | null }): Promise<void> {
    await this.prisma.parkedPhone.deleteMany({
      where: {
        OR: [
          { formerUserId: params.userId },
          ...(params.phone ? [{ phone: params.phone }] : []),
        ],
      },
    });
  }

  async isPhoneParked(phone: string, now = new Date()): Promise<boolean> {
    const row = await this.prisma.parkedPhone.findUnique({
      where: { phone },
      select: { releaseAt: true },
    });
    return Boolean(row && row.releaseAt > now);
  }

  private async requirePage(pageUserId: string) {
    const page = await this.prisma.user.findUnique({
      where: { id: pageUserId },
      select: {
        id: true,
        username: true,
        name: true,
        accountKind: true,
        isOrganization: true,
      },
    });
    if (!page) throw new NotFoundException('Page not found.');
    if (page.accountKind !== AccountKind.page) {
      throw new BadRequestException('Target account is not a page.');
    }
    return page;
  }

  private async requirePersonOperator(operatorUserId: string) {
    const operator = await this.prisma.user.findUnique({
      where: { id: operatorUserId },
      select: {
        id: true,
        username: true,
        name: true,
        avatarKey: true,
        avatarUpdatedAt: true,
        accountKind: true,
        bannedAt: true,
        premium: true,
        verifiedStatus: true,
      },
    });
    if (!operator) throw new NotFoundException('Operator not found.');
    if (operator.accountKind !== AccountKind.person) {
      throw new BadRequestException('Only a person account can operate a page.');
    }
    if (operator.bannedAt) throw new BadRequestException('That operator is banned.');
    return operator;
  }

  private async linkOperator(pageUserId: string, operatorUserId: string, isOrganization: boolean) {
    try {
      await this.prisma.userPageOperator.create({
        data: { pageUserId, operatorUserId },
      });
    } catch (err: unknown) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
        throw err;
      }
    }

    if (isOrganization) {
      try {
        await this.prisma.userOrgMembership.create({
          data: { userId: operatorUserId, orgId: pageUserId },
        });
      } catch (err: unknown) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
          throw err;
        }
      }
    }
  }

  private toOperatorDto(row: {
    id: string;
    username: string | null;
    name: string | null;
    avatarKey: string | null;
    avatarUpdatedAt: Date | null;
  }): PageOperatorDto {
    return {
      id: row.id,
      username: row.username,
      name: row.name,
      avatarUrl: publicAssetUrl({
        publicBaseUrl: this.publicBaseUrl,
        key: row.avatarKey,
        updatedAt: row.avatarUpdatedAt,
      }),
    };
  }
}
