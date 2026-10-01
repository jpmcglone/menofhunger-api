import { Controller, Delete, Get, NotFoundException, Param, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard';
import { PartnerAccessService } from './partner-access.service';
import { PrismaService } from '../prisma/prisma.service';
import type { PartnerConnectionDto } from './partner.dto';

@Controller('me/connections')
@UseGuards(AuthGuard)
export class PartnerConnectionsController {
  constructor(private readonly prisma: PrismaService, private readonly access: PartnerAccessService) {}
  @Get()
  async list(@Req() req: AuthedRequest): Promise<{ data: PartnerConnectionDto[] }> {
    if (req.user?.impersonatedByUserId) throw new NotFoundException();
    const grants = await this.prisma.partnerGrant.findMany({ where: { userId: req.user!.id, revokedAt: null }, orderBy: { createdAt: 'desc' } });
    const clients = await this.prisma.partnerClient.findMany({ where: { id: { in: grants.map(g => g.clientId) } }, select: { id: true, name: true, active: true } });
    return { data: await Promise.all(grants.map(async g => {
      const client = clients.find(c => c.id === g.clientId);
      let status: PartnerConnectionDto['status'] = g.expiresAt <= new Date() ? 'expired' : !client?.active ? 'suspended' : 'active';
      if (status === 'active') {
        try { await this.access.assertAccount(g.userId, g.operatorUserId); }
        catch { status = 'needs_reauthorization'; }
      }
      return { id: g.id, clientName: client?.name ?? 'Application', accountId: g.userId, status,
        scopes: g.scopes, createdAt: g.createdAt.toISOString(), expiresAt: g.expiresAt.toISOString() };
    })) };

  }
  @Get('deliveries')
  async deliveries(@Req() req: AuthedRequest) {
    if (req.user?.impersonatedByUserId) throw new NotFoundException();
    const rows = await this.prisma.outboundDelivery.findMany({ where: { userId: req.user!.id }, orderBy: { updatedAt: 'desc' }, take: 50 });
    return { data: rows.map(row => ({ id: row.id, platform: row.platform, resourceKind: row.resourceKind,
      resourceId: row.resourceId, status: row.status, action: row.action, lastError: row.lastError,
      updatedAt: row.updatedAt.toISOString(), remoteUrl: !row.remoteId ? null : row.platform === 'x'
        ? `https://x.com/i/status/${encodeURIComponent(row.remoteId)}`
        : `https://pickax.com/${row.resourceKind === 'article' && row.mode === 'native' ? 'articles' : 'post'}/${encodeURIComponent(row.remoteId)}` })) };
  }
  @Delete(':id')
  async revoke(@Req() req: AuthedRequest, @Param('id') id: string) {
    if (req.user?.impersonatedByUserId) throw new NotFoundException();
    const grant = await this.prisma.partnerGrant.findFirst({ where: { id, userId: req.user!.id } });
    if (!grant) throw new NotFoundException();
    await this.access.revoke(id);
    return { data: { revoked: true } };
  }
}
