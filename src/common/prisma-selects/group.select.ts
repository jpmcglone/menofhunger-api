/** Centralized Prisma selects for community-group (and crew wall) references. */

/** Minimal group reference: id, slug, display name. */
export const GROUP_REF_SELECT = { id: true, slug: true, name: true } as const;

/** Group reference plus avatar, for list rows and conversation previews. */
export const GROUP_CARD_SELECT = { ...GROUP_REF_SELECT, avatarImageUrl: true } as const;

/** Group reference plus avatar and cover, for moderation/review surfaces. */
export const GROUP_MEDIA_SELECT = { ...GROUP_CARD_SELECT, coverImageUrl: true } as const;
