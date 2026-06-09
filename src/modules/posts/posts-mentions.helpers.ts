import type { PrismaService } from '../prisma/prisma.service';

/**
 * Mention-username resolution shared by post create/update and draft flows.
 * Free functions (taking prisma explicitly) so both PostsService and
 * PostsDraftsService can use them without a service dependency.
 */

/**
 * Resolve a list of @usernames to a lowercased-username → userId map in a single query.
 * Used by createPost to avoid running the same query twice (for body mentions vs. all mentions).
 */
export async function resolveMentionUsernamesMap(
  prisma: PrismaService,
  usernames: string[],
): Promise<Map<string, string>> {
  if (usernames.length === 0) return new Map();
  const normalized = [...new Set(usernames.map((u) => u.trim().slice(0, 120)).filter(Boolean))];
  if (normalized.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: {
      usernameIsSet: true,
      bannedAt: null,
      OR: normalized.map((u) => ({ username: { equals: u, mode: 'insensitive' as const } })),
    },
    select: { id: true, username: true },
  });
  const byLower = new Map<string, string>();
  for (const u of users) {
    if (u.username) byLower.set(u.username.toLowerCase(), u.id);
  }
  return byLower;
}

/** Resolve usernames to user ids (case-insensitive, usernameIsSet). Invalid usernames ignored. */
export async function resolveMentionUsernames(prisma: PrismaService, usernames: string[]): Promise<string[]> {
  if (usernames.length === 0) return [];
  const byLower = await resolveMentionUsernamesMap(prisma, usernames);
  if (byLower.size === 0) return [];
  const normalized = [...new Set(usernames.map((u) => u.trim().slice(0, 120)).filter(Boolean))];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const name of normalized) {
    const id = byLower.get(name.toLowerCase());
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}
