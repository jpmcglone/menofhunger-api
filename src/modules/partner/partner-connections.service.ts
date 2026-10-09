import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PartnerAccessService } from './partner-access.service';
import type { PartnerConnectionDto } from './partner.dto';

@Injectable()
export class PartnerConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PartnerAccessService,
  ) {}

  async list(userId: string): Promise<PartnerConnectionDto[]> {
    const grants = await this.prisma.partnerGrant.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const clients = await this.prisma.partnerClient.findMany({
      where: { id: { in: grants.map((g) => g.clientId) } },
      select: { id: true, name: true, active: true },
    });
    return Promise.all(
      grants.map(async (g) => {
        const client = clients.find((c) => c.id === g.clientId);
        let status: PartnerConnectionDto['status'] = g.expiresAt <= new Date() ? 'expired' : !client?.active ? 'suspended' : 'active';
        if (status === 'active') {
          try {
            await this.access.assertAccount(g.userId, g.operatorUserId);
          } catch {
            status = 'needs_reauthorization';
          }
        }
        return {
          id: g.id,
          clientName: client?.name ?? 'Application',
          accountId: g.userId,
          status,
          scopes: g.scopes,
          createdAt: g.createdAt.toISOString(),
          expiresAt: g.expiresAt.toISOString(),
        };
      }),
    );
  }

  async deliveries(userId: string) {
    const rows = await this.prisma.outboundDelivery.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      platform: row.platform,
      resourceKind: row.resourceKind,
      resourceId: row.resourceId,
      status: row.status,
      action: row.action,
      lastError: row.lastError,
      updatedAt: row.updatedAt.toISOString(),
      remoteUrl: !row.remoteId
        ? null
        : row.platform === 'x'
          ? `https://x.com/i/status/${encodeURIComponent(row.remoteId)}`
          : `https://pickax.com/${row.resourceKind === 'article' && row.mode === 'native' ? 'articles' : 'post'}/${encodeURIComponent(row.remoteId)}`,
    }));
  }

  async revoke(userId: string, id: string) {
    const grant = await this.prisma.partnerGrant.findFirst({ where: { id, userId } });
    if (!grant) throw new NotFoundException();
    await this.access.revoke(id);
  }
}
