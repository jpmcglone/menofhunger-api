import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { getSessionCookie } from '../../common/session-cookie';
import type { AuthMeDto } from '../../common/dto/auth.dto';
import { AuthMeService } from './auth-me.service';

@ApiTags('Auth')
@Controller('auth')
export class AuthMeController {
  constructor(private readonly authMe: AuthMeService) {}

  @ApiOperation({ summary: 'Get the authenticated user (me) plus live notification/message counts' })
  @Get('me')
  async me(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: AuthMeDto | null }> {
    return this.authMe.me(getSessionCookie(req), res);
  }
}
