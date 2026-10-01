import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PartnerAccessService {
  constructor(private readonly prisma: PrismaService) {}
  async assertAccount(userId: string, operatorUserId: string) {
    const [account, operator] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, accountKind: true, bannedAt: true, username: true } }),
      this.prisma.user.findUnique({ where: { id: operatorUserId }, select: { id: true, accountKind: true, bannedAt: true } }),
    ]);
    if (!account || account.bannedAt || !account.username || !operator || operator.bannedAt || operator.accountKind !== 'person') throw new UnauthorizedException();
    if (account.accountKind === 'person' && account.id !== operator.id) throw new ForbiddenException();
    if (account.accountKind === 'page' && !(await this.prisma.userPageOperator.findUnique({ where: { operatorUserId_pageUserId: { operatorUserId, pageUserId: userId } } }))) throw new ForbiddenException('A current page operator must reconnect this app.');
    return account;
  }
  async grant(id: string, clientId?: string) {
    const grant = await this.prisma.partnerGrant.findUnique({ where: { id } });
    if (!grant || grant.revokedAt || grant.expiresAt <= new Date() || (clientId && grant.clientId !== clientId)) throw new UnauthorizedException('Connection expired or revoked.');
    const client = await this.prisma.partnerClient.findUnique({ where: { id: grant.clientId } });
    if (!client?.active) throw new UnauthorizedException('Application access is suspended.');
    await this.assertAccount(grant.userId, grant.operatorUserId);
    return { grant, client };
  }
  async revoke(id: string) {
    await this.prisma.$transaction([
      this.prisma.partnerGrant.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.prisma.partnerOidcRecord.deleteMany({ where: { grantId: id } }),
    ]);
  }
}
