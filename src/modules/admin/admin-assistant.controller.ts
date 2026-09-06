import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { sharedTools } from '../mcp/mcp-tools';
import { getSessionCookie } from '../../common/session-cookie';
import { AdminGuard, type AdminRequest } from './admin.guard';
import { AdminAssistantService } from './admin-assistant.service';

const messageSchema = z.object({ id: z.string().uuid(), message: z.string().trim().min(1).max(6000) }).strict();
const decisionSchema = z.object({ decision: z.enum(['confirm', 'cancel']) }).strict();

@UseGuards(AdminGuard)
@Controller('admin/assistant')
export class AdminAssistantController {
  constructor(private readonly assistant: AdminAssistantService) {}

  @Get('capabilities')
  capabilities() {
    return { data: sharedTools.capabilities() };
  }

  @Get()
  async workspace(@Req() req: AdminRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return { data: await this.assistant.workspace(req.user!.id) };
  }

  @Post('messages')
  async message(@Body() body: unknown, @Req() req: AdminRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const input = messageSchema.parse(body);
    return { data: await this.assistant.ask(req.user!.id, getSessionCookie(req)!, input) };
  }

  @Post('actions/:id')
  async decide(@Param('id') id: string, @Body() body: unknown, @Req() req: AdminRequest) {
    const { decision } = decisionSchema.parse(body);
    return { data: await this.assistant.decide(req.user!.id, getSessionCookie(req)!, z.string().uuid().parse(id), decision) };
  }
}
