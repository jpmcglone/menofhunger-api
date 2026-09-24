import { Controller, Delete, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard';
import type { AdminMcpConnectionsDto, McpRevokeResultDto } from '../../common/dto/mcp.dto';
import { McpConnectionsService } from './mcp-connections.service';

@UseGuards(AdminGuard)
@Controller('admin/users/:userId/mcp-connections')
export class AdminMcpConnectionsController {
  constructor(private readonly connections: McpConnectionsService) {}

  @Get()
  async list(@Param('userId') userId: string): Promise<{ data: AdminMcpConnectionsDto }> {
    const [usage, connections] = await Promise.all([
      this.connections.usage(userId),
      this.connections.list(userId),
    ]);
    return { data: { usage, connections } };
  }

  @Delete(':connectionId')
  async revoke(
    @Param('userId') userId: string,
    @Param('connectionId') connectionId: string,
  ): Promise<{ data: McpRevokeResultDto }> {
    if (!(await this.connections.revoke(userId, connectionId))) throw new NotFoundException('Connection not found.');
    return { data: { revoked: true } };
  }
}
