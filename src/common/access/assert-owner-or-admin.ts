import { ForbiddenException } from '@nestjs/common';

/** Throw `ForbiddenException(message)` unless the viewer owns the resource or is a site admin. */
export function assertOwnerOrAdmin(
  viewer: { userId: string; isSiteAdmin?: boolean },
  ownerId: string | null | undefined,
  message = 'Forbidden',
): void {
  if (viewer.isSiteAdmin) return;
  if (!ownerId || ownerId !== viewer.userId) throw new ForbiddenException(message);
}
