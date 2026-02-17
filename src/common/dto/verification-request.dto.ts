import type { User, VerificationRequest, VerificationRequestStatus, VerifiedStatus } from '@prisma/client';

export type VerificationRequestPublicDto = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: VerificationRequestStatus;
  provider: string | null;
  providerRequestId: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
};

export type VerificationRequestAdminUserSummaryDto = {
  id: string;
  createdAt: string;
  phone: string;
  email: string | null;
  username: string | null;
  usernameIsSet: boolean;
  name: string | null;
  siteAdmin: boolean;
  premium: boolean;
  premiumPlus: boolean;
  verifiedStatus: VerifiedStatus;
  verifiedAt: string | null;
  unverifiedAt: string | null;
};

export type VerificationRequestAdminDto = VerificationRequestPublicDto & {
  user: VerificationRequestAdminUserSummaryDto;
  reviewedByAdmin: { id: string; username: string | null; name: string | null } | null;
  adminNote: string | null;
};

export function toVerificationRequestPublicDto(req: VerificationRequest): VerificationRequestPublicDto {
  return {
    id: req.id,
    createdAt: req.createdAt.toISOString(),
    updatedAt: req.updatedAt.toISOString(),
    status: req.status,
    provider: req.provider ?? null,
    providerRequestId: req.providerRequestId ?? null,
    reviewedAt: req.reviewedAt ? req.reviewedAt.toISOString() : null,
    rejectionReason: req.rejectionReason ?? null,
  };
}

type VerificationAdminUserRow = Pick<
  User,
  | 'id'
  | 'createdAt'
  | 'phone'
  | 'email'
  | 'username'
  | 'usernameIsSet'
  | 'name'
  | 'siteAdmin'
  | 'premium'
  | 'premiumPlus'
  | 'verifiedStatus'
  | 'verifiedAt'
  | 'unverifiedAt'
>;

function toAdminUserSummaryDto(user: VerificationAdminUserRow): VerificationRequestAdminUserSummaryDto {
  return {
    id: user.id,
    createdAt: user.createdAt.toISOString(),
    phone: user.phone,
    email: user.email ?? null,
    username: user.username,
    usernameIsSet: Boolean(user.usernameIsSet),
    name: user.name ?? null,
    siteAdmin: Boolean(user.siteAdmin),
    premium: Boolean(user.premium),
    premiumPlus: Boolean(user.premiumPlus),
    verifiedStatus: user.verifiedStatus,
    verifiedAt: user.verifiedAt ? user.verifiedAt.toISOString() : null,
    unverifiedAt: user.unverifiedAt ? user.unverifiedAt.toISOString() : null,
  };
}

export function toVerificationRequestAdminDto(
  req: VerificationRequest & {
    user: VerificationAdminUserRow;
    reviewedByAdmin?: Pick<User, 'id' | 'username' | 'name'> | null;
  },
): VerificationRequestAdminDto {
  return {
    ...toVerificationRequestPublicDto(req),
    user: toAdminUserSummaryDto(req.user),
    reviewedByAdmin: req.reviewedByAdmin
      ? { id: req.reviewedByAdmin.id, username: req.reviewedByAdmin.username ?? null, name: req.reviewedByAdmin.name ?? null }
      : null,
    adminNote: req.adminNote ?? null,
  };
}

