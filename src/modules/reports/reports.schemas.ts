import { z } from 'zod';

export const createSchema = z.object({
  targetType: z.enum(['post', 'user', 'message', 'article']),
  subjectPostId: z.string().cuid().optional(), subjectUserId: z.string().cuid().optional(),
  subjectMessageId: z.string().cuid().optional(), subjectArticleId: z.string().cuid().optional(),
  reason: z.enum(['spam', 'harassment', 'hate', 'sexual', 'violence', 'illegal', 'other']),
  details: z.union([z.string().trim().min(1).max(5000), z.null()]).optional(),
}).strict().superRefine((value, context) => {
  const keys = { post: 'subjectPostId', user: 'subjectUserId', message: 'subjectMessageId', article: 'subjectArticleId' } as const;
  for (const key of Object.values(keys)) {
    if (key === keys[value.targetType] ? !value[key] : Boolean(value[key])) context.addIssue({ code: z.ZodIssueCode.custom, message: `Provide only the ${value.targetType} being reported.`, path: [key] });
  }
});
