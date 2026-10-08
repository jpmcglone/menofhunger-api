/** Single definition of "is this viewer a site admin". */
export function isSiteAdminViewer(viewer: { siteAdmin?: boolean | null } | null | undefined): boolean {
  return Boolean(viewer?.siteAdmin);
}

/** Resolve a user id to the site-admin flag via any lookup that supports `{ siteAdmin: true }` selection. */
export async function isSiteAdminUser(
  users: { findById(id: string, select: { siteAdmin: true }): Promise<{ siteAdmin?: boolean | null } | null> },
  userId: string,
): Promise<boolean> {
  return isSiteAdminViewer(await users.findById(userId, { siteAdmin: true }));
}
