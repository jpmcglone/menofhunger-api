import { Body, Controller, ForbiddenException, Get, Header, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard';
import { MarvinPersonalService } from './services/marvin-personal.service';
import { MarvinParticipationService } from './services/marvin-participation.service';

@Controller('marvin')
@UseGuards(AuthGuard)
export class MarvinPersonalController {
  constructor(private readonly personal: MarvinPersonalService, private readonly participation: MarvinParticipationService) {}

  private owner(req: AuthedRequest) {
    if (!req.user || req.user.impersonatedByUserId || req.user.operatedByUserId) throw new ForbiddenException('Use your own account for personal MARV actions.');
    return req.user.id;
  }

  @Get('actions')
  @Header('Cache-Control', 'no-store')
  async actions(@Req() req: AuthedRequest) { return { data: await this.personal.list(this.owner(req)) }; }

  @Post('actions/:id')
  @Header('Cache-Control', 'no-store')
  async decide(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: unknown) {
    const { decision } = z.object({ decision: z.enum(['confirm', 'cancel']) }).strict().parse(body);
    return { data: await this.personal.decide(this.owner(req), z.string().uuid().parse(id), decision) };
  }

  @Get('participation')
  @Header('Cache-Control', 'no-store')
  async suggestions(@Req() req: AuthedRequest, @Query() query: unknown) {
    const { postId } = z.object({ postId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional() }).strict().parse(query);
    return { data: await this.participation.suggestions(this.owner(req), postId) };
  }
}
