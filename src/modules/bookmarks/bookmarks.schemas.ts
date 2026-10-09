import { z } from 'zod';

export const createCollectionSchema = z.object({
  name: z.string().trim().min(1).max(40),
});

export const renameCollectionSchema = z.object({
  name: z.string().trim().min(1).max(40),
});

export const setBookmarkSchema = z.object({
  // Folder membership follows a strict mutual-exclusivity invariant:
  //   - omitted / null  → keep the bookmark's current folder state unchanged
  //   - []              → explicitly "unorganized": removes the bookmark from ALL folders
  //   - [...ids]        → full replace: bookmark is in exactly these folders (no longer unorganized)
  //
  // Prefer `collectionIds` (multi-folder). `collectionId` is kept for backwards compatibility
  // and is treated as `collectionIds: [collectionId]` when `collectionIds` is not provided.
  collectionIds: z.array(z.string().trim().min(1)).max(40).optional().nullable(),
  collectionId: z.string().trim().min(1).optional().nullable(),
});
