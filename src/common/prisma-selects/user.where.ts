import type { Prisma } from '@prisma/client';

/** Users who are not banned. Spread into a `User` where clause or a relation filter. */
export const NOT_BANNED_USER_WHERE = { bannedAt: null } satisfies Prisma.UserWhereInput;
