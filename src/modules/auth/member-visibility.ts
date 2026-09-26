import type { PrismaService } from '../prisma/prisma.service';

type VisibilityFields = {
  /** Socket viewers carry a precomputed flag instead of the raw status. */
  verified?: boolean | null;
  verifiedStatus?: string | null;
  premium?: boolean | null;
  premiumPlus?: boolean | null;
  siteAdmin?: boolean | null;
};

/**
 * Who may see *which* members are online or where they live. Everyone else still gets the
 * counts. Mirrors VerifiedGuard (verified or Premium) plus site admins.
 */
export function canSeeMembers(user: VisibilityFields | null | undefined): boolean {
  if (!user) return false;
  const verified = user.verified === true || (user.verifiedStatus ?? 'none') !== 'none';
  return verified || Boolean(user.premium || user.premiumPlus || user.siteAdmin);
}

export async function viewerCanSeeMembers(prisma: PrismaService, viewerUserId: string | null | undefined): Promise<boolean> {
  if (!viewerUserId) return false;
  const user = await prisma.user.findUnique({
    where: { id: viewerUserId },
    select: { verifiedStatus: true, premium: true, premiumPlus: true, siteAdmin: true },
  });
  return canSeeMembers(user);
}
