import { PartnerAccessService } from './partner-access.service';
import { defaultedCursorPageQuerySchema } from '../../common/pagination/cursor-query.schema';
import { randomBytes } from 'node:crypto';
import { RedisService } from '../redis/redis.service';
import { AppConfigService } from '../app/app-config.service';
import {
  applyDecorators,
  type Type,
  HttpCode,
  Body,
  Post,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  Param,
  Query,
  Req,
  Res,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOkResponse, ApiExtraModels, ApiQuery, ApiBody, getSchemaPath, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { PartnerOAuthService } from './partner-oauth.service';
import { PartnerRateService } from './partner-rate.service';
import { PartnerReadService } from './partner-read.service';
import {
  PartnerContentDto,
  PartnerProfileDto,
  PartnerVerificationDto,
  PartnerPaginationDto,
  PartnerArticleCommentDto,
  PartnerContinuationDto,
} from './partner.dto';
import { pagination } from './partner.schemas';

const Result = (dto: Type<unknown>, list = false) =>
  applyDecorators(
    ApiExtraModels(dto, PartnerPaginationDto),
    ApiOkResponse({
      schema: {
        type: 'object',
        required: list ? ['data', 'pagination'] : ['data'],
        properties: {
          data: list ? { type: 'array', items: { $ref: getSchemaPath(dto) } } : { $ref: getSchemaPath(dto) },
          ...(list ? { pagination: { $ref: getSchemaPath(PartnerPaginationDto) } } : {}),
        },
      },
    }),
    ...(list
      ? [
          ApiQuery({ name: 'cursor', required: false, type: String }),
          ApiQuery({
            name: 'limit',
            required: false,
            schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
          }),
        ]
      : []),
  );

type PartnerRequest = Request & { partner: Awaited<ReturnType<PartnerOAuthService['tokenPrincipal']>> };
const Scope = (scope: string) => SetMetadata('partnerScope', scope);
@Injectable()
export class PartnerGuard implements CanActivate {
  constructor(
    private readonly oauth: PartnerOAuthService,
    private readonly rate: PartnerRateService,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<PartnerRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    res.setHeader('Cache-Control', 'no-store');
    const token = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) {
      await this.rate.check([{ key: `unauthorized:${req.ip}`, limit: 30 }], res);
      res.setHeader('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedException();
    }
    try {
      req.partner = await this.oauth.tokenPrincipal(token);
    } catch (error) {
      await this.rate.check([{ key: `unauthorized:${req.ip}`, limit: 30 }], res);
      res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
      throw error;
    }
    const { client, grant, scopes } = req.partner;
    await this.rate.check(
      [
        { key: `client:${client.id}`, limit: client.clientReadLimit },
        { key: `account:${client.id}:${grant.userId}`, limit: client.accountReadLimit },
      ],
      res,
    );
    const scope = this.reflector.get<string>('partnerScope', context.getHandler());
    if (scope && !scopes.includes(scope)) throw new ForbiddenException(`This connection requires ${scope}.`);
    return true;
  }
}
@ApiTags('Partner')
@ApiBearerAuth('partner')
@SkipThrottle()
@UseGuards(PartnerGuard)
@Controller('partner')
export class PartnerController {
  constructor(
    private readonly reads: PartnerReadService,
    private readonly rate: PartnerRateService,
    private readonly redis: RedisService,
    private readonly cfg: AppConfigService,
    private readonly access: PartnerAccessService,
  ) {}
  @Post('connection/continue')
  @HttpCode(200)
  @Scope('account:read')
  @Result(PartnerContinuationDto)
  @ApiBody({
    schema: {
      type: 'object',
      required: ['externalAccountId'],
      properties: { externalAccountId: { type: 'string', minLength: 1, maxLength: 200 } },
    },
  })
  async continuePairing(@Req() req: PartnerRequest, @Body() body: unknown) {
    if (req.partner.client.platform !== 'pickax') throw new ForbiddenException();
    const input = z
      .object({ externalAccountId: z.string().min(1).max(200) })
      .strict()
      .parse(body);
    const connection = await this.access.pickaxConnection(req.partner.grant.userId);
    if (
      connection?.status === 'active' &&
      connection.pickaxUserId === input.externalAccountId &&
      connection.authorizedByUserId === req.partner.grant.operatorUserId
    ) {
      return { data: { url: `${this.cfg.frontendBaseUrl()}/settings/integrations`, expiresIn: 0 } };
    }
    const continuation = randomBytes(32).toString('base64url');
    await this.redis.setJson(
      `partner:pickax:continue:${continuation}`,
      { grantId: req.partner.grant.id, externalAccountId: input.externalAccountId },
      { ttlSeconds: 600 },
    );
    return {
      data: { url: `${this.cfg.frontendBaseUrl()}/connect/pickax?continuation=${continuation}`, expiresIn: 600 },
    };
  }
  @Get('me')
  @Scope('account:read')
  @Result(PartnerProfileDto)
  async me(@Req() req: PartnerRequest) {
    return { data: await this.reads.profile(req.partner.grant.userId, req.partner.grant.userId, true) };
  }
  @Get('me/verification')
  @Scope('verification:read')
  @Result(PartnerVerificationDto)
  async verification(@Req() req: PartnerRequest) {
    return { data: await this.reads.verification(req.partner.grant.userId) };
  }
  @Get('users/:username')
  @Scope('account:read')
  @Result(PartnerProfileDto)
  async user(@Req() req: PartnerRequest, @Param('username') username: string) {
    return { data: await this.reads.profile(req.partner.grant.userId, username) };
  }
  @Get('me/following')
  @Result(PartnerProfileDto, true)
  @Scope('social:read')
  following(@Req() req: PartnerRequest, @Query() query: unknown) {
    return this.reads.social(req.partner.grant.userId, 'following', pagination.parse(query));
  }
  @Get('me/followers')
  @Result(PartnerProfileDto, true)
  @Scope('social:read')
  followers(@Req() req: PartnerRequest, @Query() query: unknown) {
    return this.reads.social(req.partner.grant.userId, 'followers', pagination.parse(query));
  }
  @Get('users/:username/posts')
  @Result(PartnerContentDto, true)
  @Scope('content:read')
  async posts(@Req() req: PartnerRequest, @Param('username') username: string, @Query() query: unknown) {
    const user = await this.reads.profile(req.partner.grant.userId, username);
    return this.reads.posts(req.partner.grant.userId, pagination.parse(query), { userId: user.id });
  }
  @Get('users/:username/articles')
  @Result(PartnerContentDto, true)
  @Scope('content:read')
  async articles(@Req() req: PartnerRequest, @Param('username') username: string, @Query() query: unknown) {
    const user = await this.reads.profile(req.partner.grant.userId, username);
    return this.reads.articles(req.partner.grant.userId, pagination.parse(query), user.id);
  }
  @Get('posts/:id')
  @Scope('content:read')
  @Result(PartnerContentDto)
  async post(@Req() req: PartnerRequest, @Param('id') id: string) {
    return { data: await this.reads.post(req.partner.grant.userId, id) };
  }
  @Get('articles/:id')
  @Scope('content:read')
  @Result(PartnerContentDto)
  async article(@Req() req: PartnerRequest, @Param('id') id: string) {
    return { data: await this.reads.article(req.partner.grant.userId, id) };
  }
  @Get('posts/:id/comments')
  @Result(PartnerContentDto, true)
  @Scope('content:read')
  comments(@Req() req: PartnerRequest, @Param('id') id: string, @Query() query: unknown) {
    return this.reads.posts(req.partner.grant.userId, pagination.parse(query), { parentId: id });
  }
  @Get('articles/:id/comments')
  @Result(PartnerArticleCommentDto, true)
  @Scope('content:read')
  articleComments(@Req() req: PartnerRequest, @Param('id') id: string, @Query() query: unknown) {
    return this.reads.articleComments(req.partner.grant.userId, id, pagination.parse(query));
  }
  @Get('search')
  @ApiExtraModels(PartnerProfileDto, PartnerContentDto, PartnerPaginationDto)
  @ApiQuery({ name: 'q', required: true, type: String })
  @ApiQuery({ name: 'type', required: true, enum: ['users', 'posts', 'articles'] })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', default: 20, maximum: 50, minimum: 1 } })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['data', 'pagination'],
      properties: {
        data: {
          type: 'array',
          items: { oneOf: [{ $ref: getSchemaPath(PartnerProfileDto) }, { $ref: getSchemaPath(PartnerContentDto) }] },
        },
        pagination: { $ref: getSchemaPath(PartnerPaginationDto) },
      },
    },
  })
  async search(@Req() req: PartnerRequest, @Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    const input = defaultedCursorPageQuerySchema({ maxLimit: 50, defaultLimit: 20, maxCursorLength: 500 })
      .extend({ q: z.string().trim().min(1).max(200), type: z.enum(['users', 'posts', 'articles']) })
      .parse(query);
    if (!req.partner.scopes.includes(input.type === 'users' ? 'account:read' : 'content:read')) throw new ForbiddenException();
    await this.rate.check([{ key: `search:${req.partner.client.id}:${req.partner.grant.userId}`, limit: 30 }], res);
    return this.reads[input.type](req.partner.grant.userId, input);
  }
}
