import type { Feedback, FeedbackCategory, FeedbackStatus } from '@prisma/client';
import { publicAssetUrl } from '../assets/public-asset-url';

export type FeedbackDto = {
  id: string;
  createdAt: string;
  updatedAt: string;
  category: FeedbackCategory;
  status: FeedbackStatus;
  email: string | null;
  subject: string;
  details: string;
};

export type FeedbackAdminDto = FeedbackDto & {
  adminNote: string | null;
  user: {
    id: string;
    username: string | null;
    name: string | null;
    avatarUrl: string | null;
  } | null;
};

export function toFeedbackDto(feedback: Feedback): FeedbackDto {
  return {
    id: feedback.id,
    createdAt: feedback.createdAt.toISOString(),
    updatedAt: feedback.updatedAt.toISOString(),
    category: feedback.category,
    status: feedback.status,
    email: feedback.email,
    subject: feedback.subject,
    details: feedback.details,
  };
}

export function toFeedbackAdminDto(
  feedback: Feedback & {
    user?: { id: string; username: string | null; name: string | null; avatarKey?: string | null; avatarUpdatedAt?: Date | null } | null;
  },
  publicAssetBaseUrl: string | null = null,
): FeedbackAdminDto {
  return {
    ...toFeedbackDto(feedback),
    adminNote: feedback.adminNote ?? null,
    user: feedback.user
      ? {
          id: feedback.user.id,
          username: feedback.user.username,
          name: feedback.user.name,
          avatarUrl: publicAssetUrl({
            publicBaseUrl: publicAssetBaseUrl,
            key: feedback.user.avatarKey ?? null,
            updatedAt: feedback.user.avatarUpdatedAt ?? null,
          }),
        }
      : null,
  };
}
