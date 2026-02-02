import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { normalizePhone } from '../auth/auth.utils';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { toUserDto } from '../users/user.dto';
import { validateUsername } from '../users/users.utils';
import { AdminGuard } from './admin.guard';

const searchSchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

const adminUsernameSchema = z.object({
  username: z.string().optional(),
});

const updateUserSchema = z.object({
  phone: z.string().trim().min(1).optional(),
  username: z.union([z.string().trim().min(1), z.null()]).optional(),
  name: z.string().trim().max(50).nullable().optional(),
  bio: z.string().trim().max(160).nullable().optional(),
  premium: z.boolean().optional(),
  verifiedStatus: z.enum(['none', 'identity', 'manual']).optional(),
});

@UseGuards(AdminGuard)
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
  ) {}

  @Get('search')
  async search(@Query() query: unknown) {
    const { q, limit, cursor } = searchSchema.parse(query);
    const take = limit ?? 20;

    const raw = (q ?? '').trim();
    const cleaned = raw.startsWith('@') ? raw.slice(1) : raw;

    const where: Prisma.UserWhereInput | undefined = cleaned
      ? {
          OR: [
            { username: { contains: cleaned, mode: 'insensitive' } },
            { name: { contains: cleaned, mode: 'insensitive' } },
            { phone: { contains: cleaned } },
          ],
        }
      : undefined;

    const users = await this.prisma.user.findMany({
      where,
      orderBy: { id: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const slice = users.slice(0, take);
    const nextCursor = users.length > take ? slice[slice.length - 1]?.id ?? null : null;
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    return {
      data: slice.map((u) => toUserDto(u, publicBaseUrl)),
      pagination: { nextCursor },
    };
  }

  @Get('username/available')
  async usernameAvailable(@Query() query: unknown) {
    const { username } = adminUsernameSchema.parse(query);
    const parsed = validateUsername(username ?? '', { minLen: 2 });
    if (!parsed.ok) return { data: { available: false, normalized: null, error: parsed.error } };

    const exists =
      (
        await this.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "User"
          WHERE LOWER("username") = LOWER(${parsed.username})
          LIMIT 1
        `
      )[0] ?? null;

    return { data: { available: !exists, normalized: parsed.usernameLower } };
  }

  @Get(':id')
  async getUser(@Param('id') id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found.');
    return { data: toUserDto(user, this.appConfig.r2()?.publicBaseUrl ?? null) };
  }

  @Patch(':id/profile')
  async updateUser(@Param('id') id: string, @Body() body: unknown) {
    const parsed = updateUserSchema.parse(body);

    const data: Prisma.UserUpdateInput = {};
    const now = new Date();

    if (parsed.phone !== undefined) {
      try {
        data.phone = normalizePhone(parsed.phone);
      } catch {
        throw new BadRequestException('Invalid phone number format');
      }
    }

    if (parsed.username !== undefined) {
      if (parsed.username === null) {
        data.username = null;
        data.usernameIsSet = false;
      } else {
        const validated = validateUsername(parsed.username, { minLen: 2 });
        if (!validated.ok) throw new BadRequestException(validated.error);
        data.username = validated.username;
        data.usernameIsSet = true;
      }
    }

    if (parsed.name !== undefined) {
      data.name = parsed.name === null ? null : (parsed.name || null);
    }

    if (parsed.bio !== undefined) {
      data.bio = parsed.bio === null ? null : (parsed.bio || null);
    }

    if (parsed.premium !== undefined) {
      data.premium = parsed.premium;
    }

    if (parsed.verifiedStatus !== undefined) {
      if (parsed.verifiedStatus === 'none') {
        data.verifiedStatus = 'none';
        data.verifiedAt = null;
        data.unverifiedAt = now;
      } else {
        data.verifiedStatus = parsed.verifiedStatus;
        data.verifiedAt = now;
        data.unverifiedAt = null;
      }
    }

    try {
      const updated = await this.prisma.user.update({
        where: { id },
        data,
      });

      return { data: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) };
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundException('User not found.');
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Unique constraint violation (phone or username lower-ci index).
        throw new ConflictException('That value is already in use.');
      }
      throw err;
    }
  }
}

