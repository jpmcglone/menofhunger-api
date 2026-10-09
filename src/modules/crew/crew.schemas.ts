import { cursorPageQuerySchema } from '../../common/pagination/cursor-query.schema';
import { z } from 'zod';

export const updateCrewSchema = z.object({
  name: z.string().trim().max(80).nullish(),
  tagline: z.string().trim().max(160).nullish(),
  bio: z.string().trim().max(4000).nullish(),
  avatarImageUrl: z.string().trim().max(2000).nullish(),
  coverImageUrl: z.string().trim().max(2000).nullish(),
  designatedSuccessorUserId: z.string().trim().min(1).nullish(),
});

export const inviteSchema = z.object({
  inviteeUserId: z.string().trim().min(1),
  message: z.string().trim().max(500).nullish(),
  /**
   * For founding invites only: name to use for the new crew when this invite is
   * accepted. Ignored for invites tied to an existing crew (rename via PATCH /crew/me).
   */
  crewName: z.string().trim().max(80).nullish(),
});

export const messageMediaSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('upload'),
    kind: z.enum(['image', 'gif', 'video']),
    r2Key: z.string().min(1),
    thumbnailR2Key: z.string().optional().nullable(),
    width: z.coerce.number().int().positive().optional().nullable(),
    height: z.coerce.number().int().positive().optional().nullable(),
    durationSeconds: z.coerce.number().min(0).optional().nullable(),
    alt: z.string().max(500).optional().nullable(),
  }),
  z.object({
    source: z.literal('giphy'),
    kind: z.literal('gif'),
    url: z.string().url(),
    mp4Url: z.string().url().optional().nullable(),
    width: z.coerce.number().int().positive().optional().nullable(),
    height: z.coerce.number().int().positive().optional().nullable(),
    alt: z.string().max(500).optional().nullable(),
  }),
]);

export const sendWallMessageSchema = z
  .object({
    body: z.string().trim().max(2000).optional(),
    media: z.array(messageMediaSchema).max(1).optional(),
  })
  .refine((v) => (v.body?.trim()?.length ?? 0) > 0 || (v.media?.length ?? 0) > 0, {
    message: 'Message must have a body or media.',
  });

export const listWallSchema = cursorPageQuerySchema();

export const transferSchema = z.object({
  newOwnerUserId: z.string().trim().min(1),
});

export const openVoteSchema = z.object({
  targetUserId: z.string().trim().min(1),
});

export const ballotSchema = z.object({
  inFavor: z.boolean(),
});

export const reorderMembersSchema = z.object({
  order: z.array(z.string().trim().min(1)).min(1).max(5),
});
