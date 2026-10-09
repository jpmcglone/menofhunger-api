import { z } from 'zod';

export const initAvatarSchema = z.object({
  contentType: z.string().min(1),
});

export const commitAvatarSchema = z.object({
  key: z.string().min(1),
});

export const initBannerSchema = z.object({
  contentType: z.string().min(1),
});

export const commitBannerSchema = z.object({
  key: z.string().min(1),
});

export const initPostMediaSchema = z.object({
  contentType: z.string().min(1),
  contentHash: z.string().min(1).optional(),
  purpose: z.enum(['post', 'thumbnail', 'group', 'crew', 'voicemail']).optional(),
});

export const commitPostMediaSchema = z.object({
  key: z.string().min(1),
  contentHash: z.string().min(1).optional(),
  thumbnailKey: z.string().min(1).optional(),
  width: z.coerce.number().int().min(1).max(20000).optional(),
  height: z.coerce.number().int().min(1).max(20000).optional(),
  durationSeconds: z.coerce.number().int().min(0).max(3600).optional(),
}).superRefine((val, ctx) => {
  const key = (val.key ?? '').trim();
  const isVideo = key.includes('/videos/') || key.includes('/voicemail/');
  const isAudio = key.includes('/audio/');
  const isVoicemail = key.includes('/voicemail/');
  if (isAudio) {
    const durationSeconds = typeof val.durationSeconds === 'number' ? val.durationSeconds : null;
    if (durationSeconds == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Audio uploads must include durationSeconds.',
        path: ['durationSeconds'],
      });
    } else if (durationSeconds > 120) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Voice notes must be 2 minutes or shorter.', path: ['durationSeconds'] });
    }
    return;
  }
  if (!isVideo) return;

  const width = typeof val.width === 'number' ? val.width : null;
  const height = typeof val.height === 'number' ? val.height : null;
  const durationSeconds = typeof val.durationSeconds === 'number' ? val.durationSeconds : null;

  if (width == null || height == null || durationSeconds == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Video uploads must include width, height, and durationSeconds.',
      path: ['width'],
    });
    return;
  }

  if (isVoicemail && durationSeconds > 60) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Video messages must be 60 seconds or shorter.', path: ['durationSeconds'] });
  } else if (!isVoicemail && durationSeconds > 5 * 60) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Video must be 5 minutes or shorter.', path: ['durationSeconds'] });
  }

  // Tier-specific limits (MB + duration) are enforced server-side in UploadsService (premium/premium+).
});
