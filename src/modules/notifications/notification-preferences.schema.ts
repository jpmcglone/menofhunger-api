import { z } from 'zod';

export const preferencesPatchSchema = z
  .object({
    pushComment: z.boolean().optional(),
    pushBoost: z.boolean().optional(),
    pushFollow: z.boolean().optional(),
    pushMention: z.boolean().optional(),
    pushMessage: z.boolean().optional(),
    pushRepost: z.boolean().optional(),
    pushNudge: z.boolean().optional(),
    pushFollowedPost: z.boolean().optional(),
    pushReplyNudge: z.boolean().optional(),
    pushCrewStreak: z.boolean().optional(),
    pushGroupActivity: z.boolean().optional(),
    pushDailyContent: z.boolean().optional(),
    pushCheckinReminder: z.boolean().optional(),
    emailDigestWeekly: z.boolean().optional(),
    emailNewNotifications: z.boolean().optional(),
    emailInstantHighSignal: z.boolean().optional(),
    emailStreakReminder: z.boolean().optional(),
    emailFollowedArticle: z.boolean().optional(),
    emailNewsletter: z.boolean().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: 'At least one preference is required.' });
