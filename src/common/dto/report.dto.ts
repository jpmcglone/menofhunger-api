import type { Report, ReportReason, ReportStatus, ReportTargetType } from '@prisma/client';

export type ReportDto = {
  id: string;
  createdAt: string;
  updatedAt: string;
  targetType: ReportTargetType;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  subjectUserId: string | null;
  subjectPostId: string | null;
};

export type ReportAdminDto = ReportDto & {
  adminNote: string | null;
  resolvedAt: string | null;
  reporter: {
    id: string;
    username: string | null;
    name: string | null;
  };
  subjectUser: {
    id: string;
    username: string | null;
    name: string | null;
  } | null;
  subjectPost: {
    id: string;
    createdAt: string;
    body: string;
    deletedAt: string | null;
    user: {
      id: string;
      username: string | null;
      name: string | null;
    };
  } | null;
  resolvedByAdmin: {
    id: string;
    username: string | null;
    name: string | null;
  } | null;
};

export function toReportDto(report: Report): ReportDto {
  return {
    id: report.id,
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString(),
    targetType: report.targetType,
    reason: report.reason,
    details: report.details ?? null,
    status: report.status,
    subjectUserId: report.subjectUserId ?? null,
    subjectPostId: report.subjectPostId ?? null,
  };
}

export function toReportAdminDto(
  report: Report & {
    reporter: { id: string; username: string | null; name: string | null };
    subjectUser?: { id: string; username: string | null; name: string | null } | null;
    subjectPost?: {
      id: string;
      createdAt: Date;
      body: string;
      deletedAt: Date | null;
      user: { id: string; username: string | null; name: string | null };
    } | null;
    resolvedByAdmin?: { id: string; username: string | null; name: string | null } | null;
  },
): ReportAdminDto {
  return {
    ...toReportDto(report),
    adminNote: report.adminNote ?? null,
    resolvedAt: report.resolvedAt ? report.resolvedAt.toISOString() : null,
    reporter: { id: report.reporter.id, username: report.reporter.username, name: report.reporter.name },
    subjectUser: report.subjectUser
      ? { id: report.subjectUser.id, username: report.subjectUser.username, name: report.subjectUser.name }
      : null,
    subjectPost: report.subjectPost
      ? {
          id: report.subjectPost.id,
          createdAt: report.subjectPost.createdAt.toISOString(),
          body: report.subjectPost.body,
          deletedAt: report.subjectPost.deletedAt ? report.subjectPost.deletedAt.toISOString() : null,
          user: {
            id: report.subjectPost.user.id,
            username: report.subjectPost.user.username,
            name: report.subjectPost.user.name,
          },
        }
      : null,
    resolvedByAdmin: report.resolvedByAdmin
      ? { id: report.resolvedByAdmin.id, username: report.resolvedByAdmin.username, name: report.resolvedByAdmin.name }
      : null,
  };
}

