import { isUniqueViolation } from '../../common/prisma/errors';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";

import { z } from "zod";
import { toOrgAffiliationDto } from "../../common/dto";
import { ORG_AFFILIATION_SELECT } from "../../common/prisma-selects/user.select";
import { AppConfigService } from "../app/app-config.service";
import { PagesService } from "../pages/pages.service";
import { PrismaService } from "../prisma/prisma.service";

/** Admin org affiliations and page-operator management for a user. */
@Injectable()
export class AdminUserOrgsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly pages: PagesService,
  ) {}

  private get publicBaseUrl(): string | null {
    return this.appConfig.r2()?.publicBaseUrl ?? null;
  }

  async listOrgMemberships(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!user) throw new NotFoundException("User not found.");

    const memberships = await this.prisma.userOrgMembership.findMany({
      where: { userId: id },
      include: {
        org: {
          select: ORG_AFFILIATION_SELECT,
        },
      },
      orderBy: { createdAt: "asc" },
    });

    const data = memberships.map((m) => toOrgAffiliationDto(m.org, this.publicBaseUrl));

    return { data };
  }
  async addOrgMembership(id: string, body: unknown) {
    const { orgId } = z.object({ orgId: z.string().min(1) }).parse(body);

    const [user, org] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id },
        select: { id: true, isOrganization: true },
      }),
      this.prisma.user.findUnique({
        where: { id: orgId },
        select: { id: true, isOrganization: true },
      }),
    ]);

    if (!user) throw new NotFoundException("User not found.");
    if (!org) throw new NotFoundException("Org user not found.");
    if (!org.isOrganization)
      throw new BadRequestException("Target account is not an organization.");
    if (user.isOrganization)
      throw new BadRequestException(
        "Organization accounts cannot be members of other orgs.",
      );
    if (user.id === org.id)
      throw new BadRequestException(
        "A user cannot be affiliated with themselves.",
      );

    try {
      await this.prisma.userOrgMembership.create({
        data: { userId: id, orgId },
      });
    } catch (err: unknown) {
      if (
        isUniqueViolation(err)
      ) {
        throw new ConflictException("Membership already exists.");
      }
      throw err;
    }

    const orgFull = await this.prisma.user.findUniqueOrThrow({
      where: { id: orgId },
      select: ORG_AFFILIATION_SELECT,
    });

    const data = toOrgAffiliationDto(orgFull, this.publicBaseUrl);

    return { data };
  }
  async removeOrgMembership(id: string, orgId: string) {
    const deleted = await this.prisma.userOrgMembership.deleteMany({
      where: { userId: id, orgId },
    });

    if (deleted.count === 0)
      throw new NotFoundException("Membership not found.");

    return { data: { success: true } };
  }
  async convertToPage(id: string, body: unknown) {
    const { operatorUserId } = z
      .object({ operatorUserId: z.string().min(1) })
      .parse(body);
    const data = await this.pages.convertToPage(id, operatorUserId);
    return { data };
  }
  async listOperators(id: string) {
    return { data: await this.pages.listOperators(id) };
  }
  async addOperator(id: string, body: unknown) {
    const { operatorUserId } = z
      .object({ operatorUserId: z.string().min(1) })
      .parse(body);
    return { data: await this.pages.addOperator(id, operatorUserId) };
  }
  async removeOperator(id: string, operatorUserId: string) {
    await this.pages.removeOperator(id, operatorUserId);
    return { data: { success: true } };
  }
  async listOperatedPages(id: string) {
    return { data: await this.pages.listOperatedPages(id) };
  }
}
