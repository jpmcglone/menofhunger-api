import { Controller, Delete, Get, NotFoundException, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { getSessionCookie } from '../../common/session-cookie';
import type { McpConnectionDto, McpRevokeResultDto } from '../../common/dto/mcp.dto';
import { mcpAccountFor } from './mcp-bootstrap';
import { McpConnectionsService } from './mcp-connections.service';

// Connections change only when an outside AI client authorizes or someone revokes one,
// so web refetches on open and after a revoke; a live socket for this list is not worth its cost.
@UseGuards(AuthGuard)
@Controller('mcp')
export class McpController {
  constructor(
    private readonly auth: AuthService,
    private readonly connections: McpConnectionsService,
  ) {}

  @Get('connection')
  async connection(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ data: McpConnectionDto }> {
    res.setHeader('Cache-Control', 'no-store');
    const session = await this.auth.meFromSessionToken(getSessionCookie(req));
    const account = mcpAccountFor(session);
    // Impersonated and page-operated sessions must not see or manage the person's connections.
    const owner = session && !session.impersonatedByUserId && !session.operatedByUserId ? session.user.id : null;
    return {
      data: {
        url: this.connections.url,
        audience: account?.audience ?? null,
        usage: account?.audience === 'member' ? await this.connections.usage(account.id) : null,
        connections: owner ? await this.connections.list(owner) : [],
      },
    };
  }

  @Delete('connections/:connectionId')
  async revoke(@Req() req: Request, @Param('connectionId') connectionId: string): Promise<{ data: McpRevokeResultDto }> {
    const session = await this.auth.meFromSessionToken(getSessionCookie(req));
    if (!session || session.impersonatedByUserId || session.operatedByUserId) throw new NotFoundException();
    if (!(await this.connections.revoke(session.user.id, connectionId))) throw new NotFoundException('Connection not found.');
    return { data: { revoked: true } };
  }
}
