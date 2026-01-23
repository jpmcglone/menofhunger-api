import { Body, Controller, Get, NotFoundException, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from './users.decorator';
import { validateUsername } from './users.utils';

const setUsernameSchema = z.object({
  username: z.string().min(1),
});

const profileSchema = z.object({
  name: z.string().trim().max(50).optional(),
  bio: z.string().trim().max(160).optional(),
});

@Controller('users')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('username/available')
  async usernameAvailable(@Query('username') username: string | undefined) {
    const parsed = validateUsername(username ?? '');
    if (!parsed.ok) return { available: false, normalized: null, error: parsed.error };

    const exists =
      (
        await this.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "User"
          WHERE LOWER("username") = LOWER(${parsed.username})
          LIMIT 1
        `
      )[0] ?? null;

    return { available: !exists, normalized: parsed.usernameLower };
  }

  @UseGuards(AuthGuard)
  @Patch('me/username')
  async setMyUsername(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsedBody = setUsernameSchema.parse(body);
    const parsed = validateUsername(parsedBody.username);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return { ok: false, error: 'User not found.' };
    if (user.usernameIsSet) return { ok: false, error: 'Username is already set.' };

    try {
      const updated = await this.prisma.user.update({
        where: { id: userId },
        data: {
          username: parsed.username,
          usernameIsSet: true,
        },
      });

      return {
        ok: true as const,
        user: {
          id: updated.id,
          phone: updated.phone,
          username: updated.username,
          usernameIsSet: updated.usernameIsSet,
          name: updated.name,
          bio: updated.bio,
        },
      };
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { ok: false as const, error: 'That username is taken.' };
      }
      throw err;
    }
  }

  @Get(':username')
  async publicProfile(@Param('username') username: string) {
    const normalized = (username ?? '').trim().toLowerCase();
    if (!normalized) throw new NotFoundException('User not found');

    const user =
      (
        await this.prisma.$queryRaw<
          Array<{ id: string; username: string | null; name: string | null; bio: string | null }>
        >`
          SELECT "id", "username", "name", "bio"
          FROM "User"
          WHERE LOWER("username") = ${normalized}
          LIMIT 1
        `
      )[0] ?? null;

    if (!user) throw new NotFoundException('User not found');
    return { user };
  }

  @UseGuards(AuthGuard)
  @Patch('me/profile')
  async updateMyProfile(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = profileSchema.parse(body);

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        name: parsed.name === undefined ? undefined : (parsed.name || null),
        bio: parsed.bio === undefined ? undefined : (parsed.bio || null),
      },
    });

    return {
      ok: true as const,
      user: {
        id: updated.id,
        phone: updated.phone,
        username: updated.username,
        usernameIsSet: updated.usernameIsSet,
        name: updated.name,
        bio: updated.bio,
      },
    };
  }
}

