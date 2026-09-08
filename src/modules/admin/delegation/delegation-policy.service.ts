import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

/** Sole feature-entitlement seam. Future per-person grants belong here; none are enabled today. */
@Injectable()
export class DelegationPolicyService {
  constructor(private readonly prisma: PrismaService) {}
  async assertAdmin(ownerId: string) {
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: {
        id: true,
        username: true,
        name: true,
        accountKind: true,
        siteAdmin: true,
        bannedAt: true,
      },
    });
    if (
      !owner ||
      !owner.siteAdmin ||
      owner.accountKind !== "person" ||
      owner.bannedAt
    )
      throw new NotFoundException();
    return owner;
  }
  async accounts(ownerId: string) {
    const owner = await this.assertAdmin(ownerId);
    const pages = await this.prisma.userPageOperator.findMany({
      where: {
        operatorUserId: ownerId,
        page: { bannedAt: null, accountKind: "page" },
      },
      select: {
        page: {
          select: { id: true, username: true, name: true, accountKind: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    return [
      {
        id: owner.id,
        username: owner.username,
        name: owner.name,
        accountKind: owner.accountKind,
      },
      ...pages.map((p) => p.page),
    ];
  }
  async actor(ownerId: string, username?: string) {
    const accounts = await this.accounts(ownerId);
    const actor = username
      ? accounts.find(
          (a) =>
            a.username?.toLowerCase() ===
            username.replace(/^@/, "").toLowerCase(),
        )
      : accounts[0];
    if (!actor)
      throw new NotFoundException("Choose your account or a page you operate.");
    return actor;
  }
  async assertActor(ownerId: string, actorId: string) {
    const accounts = await this.accounts(ownerId);
    const actor = accounts.find((a) => a.id === actorId);
    if (!actor)
      throw new NotFoundException(
        "This account is no longer available to you.",
      );
    return actor;
  }
}
