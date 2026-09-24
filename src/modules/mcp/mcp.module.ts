import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminMcpConnectionsController } from './admin-mcp-connections.controller';
import { McpConnectionsService } from './mcp-connections.service';
import { McpController } from './mcp.controller';

@Module({
  imports: [AuthModule],
  controllers: [McpController, AdminMcpConnectionsController],
  providers: [McpConnectionsService],
})
export class McpModule {}
