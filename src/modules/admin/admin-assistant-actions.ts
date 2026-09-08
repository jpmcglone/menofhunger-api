import { jobInputSchema } from './delegation/delegation.schemas';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { PrismaService } from '../prisma/prisma.service';
import { updateSchema as feedbackSchema } from './admin-feedback.controller';
import { updateSchema as reportSchema } from './admin-reports.controller';
import { writeSchema as announcementSchema } from './admin-announcements.controller';
import { writeSchema as newsletterSchema } from './admin-newsletters.controller';
import { approveSchema, rejectSchema } from './admin-verification.controller';
import { adminUserPatchSchema } from '../marvin/marvin.controller';

export const assistantPostSchema = z.object({
  body: z.string().trim().min(1).max(1000),
  visibility: z.enum(['public', 'verifiedOnly', 'premiumOnly', 'onlyMe']).default('public'),
  authorUsername: z.string().regex(/^@?[A-Za-z0-9_]{1,40}$/).optional(),
}).strict();

const target = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const changed = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) => schema.strict().refine(
  (input) => Object.keys(input).length > 0, 'Provide at least one change.',
);
type Operation = {
  name: string;
  description: string;
  method: 'POST' | 'PATCH';
  path: string;
  schema: z.ZodTypeAny;
  target: 'feedback' | 'report' | 'verification' | 'announcement' | 'newsletter' | 'marv' | null;
  link: string;
};
/** Adapters share the controllers' input schemas; no business rules or fan-out here. */
export const adminActions: Operation[] = [
  { name: 'post_publish', description: 'Publish this exact post immediately after review, with body, visibility (public, verifiedOnly, premiumOnly, onlyMe), and optional authorUsername. Omitted author means your personal admin account; explicit authors must be your account or an operated page. Uses canonical post permissions. Do not create a job for a request to post now.', method: 'POST', path: 'posts', schema: assistantPostSchema, target: null, link: '/admin/assistant' },
  { name: 'delegation_job_create', description: 'Create an admin-only delegated job. Default actor is your own account; choose an operated page only when requested. Review is default. Automatic sourced-news publication requires explicit authorization. Inspect delegation_workspace first. The job continues until paused or cancelled.', method: 'POST', path: 'admin/delegation/jobs', schema: jobInputSchema, target: null, link: '/admin/delegation' },
  { name: 'feedback_update', description: 'Change feedback status or internal admin note. Does not send a reply.', method: 'PATCH', path: 'admin/feedback/:id', schema: changed(feedbackSchema), target: 'feedback', link: '/admin/feedback' },
  { name: 'report_update', description: 'Change a report status or internal note. Marking actionTaken records a decision; it does not ban a user or remove a post.', method: 'PATCH', path: 'admin/reports/:id', schema: changed(reportSchema), target: 'report', link: '/admin/reports' },
  { name: 'verification_approve', description: 'Approve this pending verification request.', method: 'PATCH', path: 'admin/verification/:id/approve', schema: approveSchema.strict(), target: 'verification', link: '/admin/verification' },
  { name: 'verification_reject', description: 'Reject this pending verification request with the stated rejection reason.', method: 'PATCH', path: 'admin/verification/:id/reject', schema: rejectSchema.strict(), target: 'verification', link: '/admin/verification' },
  { name: 'announcement_create', description: 'Create an unpublished announcement draft.', method: 'POST', path: 'admin/announcements', schema: changed(announcementSchema), target: null, link: '/admin/announcements' },
  { name: 'announcement_update', description: 'Edit an announcement. Changes to a published announcement are immediately visible.', method: 'PATCH', path: 'admin/announcements/:id', schema: changed(announcementSchema), target: 'announcement', link: '/admin/announcements/:id' },
  ...(['publish', 'unpublish', 'archive'] as const).map((verb): Operation => ({ name: `announcement_${verb}`, description: `${verb} the exact announcement shown in the proposal.`, method: 'POST', path: `admin/announcements/:id/${verb}`, schema: z.object({}).strict(), target: 'announcement', link: '/admin/announcements/:id' })),
  { name: 'newsletter_create', description: 'Create a newsletter draft without sending. bodyJson is a ProseMirror doc JSON string with paragraphs and text nodes. Sending and scheduling require the newsletter editor.', method: 'POST', path: 'admin/newsletters', schema: changed(newsletterSchema), target: null, link: '/admin/newsletters' },
  { name: 'newsletter_update', description: 'Edit an unscheduled newsletter draft, without sending or scheduling. bodyJson uses ProseMirror doc JSON.', method: 'PATCH', path: 'admin/newsletters/:id', schema: changed(newsletterSchema), target: 'newsletter', link: '/admin/newsletters/:id' },
  { name: 'marv_user_update', description: 'Adjust one member’s MARV credits or disabled setting. Does not change paid membership.', method: 'PATCH', path: 'admin/marvin/users/:id', schema: changed(adminUserPatchSchema), target: 'marv', link: '/admin/marv' },
];

export function actionArguments(operation: Operation) {
  return z.object({ ...(operation.target ? { targetId: target } : {}), changes: operation.schema }).strict();
}

export async function actionSnapshot(prisma: PrismaService, operation: Operation, id?: string) {
  if (!operation.target) return { state: 'new draft' };
  if (!id) throw new BadRequestException('Choose the exact target first.');
  let row: unknown;
  switch (operation.target) {
    case 'feedback':
      row = await prisma.feedback.findUnique({ where: { id }, select: { id: true, subject: true, status: true, adminNote: true, updatedAt: true } });
      break;
    case 'report':
      row = await prisma.report.findUnique({ where: { id }, select: { id: true, targetType: true, subjectUserId: true, subjectPostId: true, reason: true, status: true, adminNote: true, updatedAt: true } });
      break;
    case 'verification':
      row = await prisma.verificationRequest.findUnique({ where: { id }, select: { id: true, userId: true, user: { select: { username: true, name: true } }, status: true, adminNote: true, rejectionReason: true, updatedAt: true } });
      if (row && (row as { status: string }).status !== 'pending') throw new BadRequestException('This verification request is no longer pending.');
      break;
    case 'announcement':
      row = await prisma.announcement.findUnique({ where: { id } });
      break;
    case 'newsletter':
      row = await prisma.newsletter.findUnique({ where: { id } });
      if (row && (row as { status: string }).status !== 'draft') throw new BadRequestException('Open the newsletter editor to change a scheduled or sent newsletter.');
      break;
    case 'marv':
      row = await prisma.user.findUnique({ where: { id }, select: { id: true, username: true, name: true } });
      if (row) row = { ...row, settings: await prisma.marvinUserSettings.findUnique({ where: { userId: id } }), credits: await prisma.marvinCreditBalance.findUnique({ where: { userId: id } }) };
      break;
  }
  if (!row) throw new NotFoundException('This target is no longer available.');
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}
