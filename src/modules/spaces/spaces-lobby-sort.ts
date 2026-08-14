export type LobbySortableSpace = {
  id: string;
  isActive: boolean;
  scheduledAt: string | null;
  listenerCount: number;
  viewerSubscribed: boolean;
  viewerFollowsOwner?: boolean;
  owner?: { id?: string | null } | null;
};

/**
 * Lobby list order:
 * 1. viewer's own space
 * 2. spaces the viewer asked to be notified about
 * 3. spaces owned by people the viewer follows
 * 4. live rooms by listener count
 * 5. soonest upcoming schedule (unscheduled last)
 */
export function compareLobbySpaces(
  a: LobbySortableSpace,
  b: LobbySortableSpace,
  opts: { viewerId: string | null; followingOwnerIds?: ReadonlySet<string> },
): number {
  const viewerId = opts.viewerId;
  const aOwn = viewerId && a.owner?.id === viewerId ? 1 : 0;
  const bOwn = viewerId && b.owner?.id === viewerId ? 1 : 0;
  if (aOwn !== bOwn) return bOwn - aOwn;

  const aSub = a.viewerSubscribed ? 1 : 0;
  const bSub = b.viewerSubscribed ? 1 : 0;
  if (aSub !== bSub) return bSub - aSub;

  const aFollow = a.viewerFollowsOwner
    ? 1
    : viewerId && a.owner?.id && a.owner.id !== viewerId && opts.followingOwnerIds?.has(a.owner.id)
      ? 1
      : 0;
  const bFollow = b.viewerFollowsOwner
    ? 1
    : viewerId && b.owner?.id && b.owner.id !== viewerId && opts.followingOwnerIds?.has(b.owner.id)
      ? 1
      : 0;
  if (aFollow !== bFollow) return bFollow - aFollow;

  if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
  if (a.isActive && b.isActive) return b.listenerCount - a.listenerCount;

  const aAt = a.scheduledAt ? Date.parse(a.scheduledAt) : Number.POSITIVE_INFINITY;
  const bAt = b.scheduledAt ? Date.parse(b.scheduledAt) : Number.POSITIVE_INFINITY;
  const aSched = Number.isFinite(aAt) ? aAt : Number.POSITIVE_INFINITY;
  const bSched = Number.isFinite(bAt) ? bAt : Number.POSITIVE_INFINITY;
  if (aSched !== bSched) return aSched - bSched;
  return a.id.localeCompare(b.id);
}
