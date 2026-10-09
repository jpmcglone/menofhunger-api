import { Controller, Delete, Get, NotFoundException, Param, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, type AuthedRequest } from '../auth/auth-public-api';
import { PartnerConnectionsService } from './partner-connections.service';
import type { PartnerConnectionDto } from './partner.dto';

@Controller('me/connections')
@UseGuards(AuthGuard)
export class PartnerConnectionsController {
  constructor(private readonly connections: PartnerConnectionsService) {}
  @Get()
  async list(@Req() req: AuthedRequest): Promise<{ data: PartnerConnectionDto[] }> {
    if (req.user?.impersonatedByUserId) throw new NotFoundException();
    return { data: await this.connections.list(req.user!.id) };
  }
  @Get('deliveries')
  async deliveries(@Req() req: AuthedRequest) {
    if (req.user?.impersonatedByUserId) throw new NotFoundException();
    return { data: await this.connections.deliveries(req.user!.id) };
  }
  @Delete(':id')
  async revoke(@Req() req: AuthedRequest, @Param('id') id: string) {
    if (req.user?.impersonatedByUserId) throw new NotFoundException();
    await this.connections.revoke(req.user!.id, id);
    return { data: { revoked: true } };
  }
}
