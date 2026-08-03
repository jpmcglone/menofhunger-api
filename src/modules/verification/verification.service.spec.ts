import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { VerificationService } from './verification.service';

type Deps = {
  prisma: any;
  slack: any;
  presenceRealtime: any;
  userVerification: any;
};

function makeTx() {
  return {
    verificationRequest: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
    user: {
      update: jest.fn(async () => ({})),
    },
  };
}

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  const tx = makeTx();
  return {
    prisma: {
      user: { findUnique: jest.fn() },
      verificationRequest: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn(async () => []),
        create: jest.fn(),
      },
      $transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) => fn(tx)),
      __tx: tx,
    },
    slack: { notifyVerificationRequested: jest.fn() },
    presenceRealtime: { emitAdminUpdated: jest.fn() },
    userVerification: { verifyUser: jest.fn(async () => ({ verified: true, alreadyVerified: false })) },
    ...overrides,
  };
}

function makeService(overrides: Partial<Deps> = {}) {
  const deps = makeDeps(overrides);
  const service = new VerificationService(
    deps.prisma,
    deps.slack,
    deps.presenceRealtime,
    deps.userVerification,
  );
  return { service, deps };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('VerificationService.createRequestForUser', () => {
  it('rejects a missing userId', async () => {
    const { service } = makeService();

    await expect(
      service.createRequestForUser({ userId: '', providerHint: null }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an unknown user', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.createRequestForUser({ userId: 'u1', providerHint: null }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects already-verified users', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({ id: 'u1', verifiedStatus: 'identity' });

    await expect(
      service.createRequestForUser({ userId: 'u1', providerHint: null }),
    ).rejects.toThrow(BadRequestException);
  });

  it('returns an existing pending request instead of creating a duplicate', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({ id: 'u1', verifiedStatus: 'none' });
    const pending = { id: 'vr1', status: 'pending' };
    deps.prisma.verificationRequest.findFirst.mockResolvedValue(pending);

    const result = await service.createRequestForUser({ userId: 'u1', providerHint: null });

    expect(result).toBe(pending);
    expect(deps.prisma.verificationRequest.create).not.toHaveBeenCalled();
  });

  it('creates a request and notifies Slack', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({ id: 'u1', verifiedStatus: 'none' });
    deps.prisma.verificationRequest.findFirst.mockResolvedValue(null);
    const created = { id: 'vr1', status: 'pending' };
    deps.prisma.verificationRequest.create.mockResolvedValue(created);

    const result = await service.createRequestForUser({ userId: 'u1', providerHint: 'manual' });

    expect(result).toBe(created);
    expect(deps.slack.notifyVerificationRequested).toHaveBeenCalledWith({
      userId: 'u1',
      providerHint: 'manual',
    });
  });
});

describe('VerificationService.getMyVerificationStatus', () => {
  it('rejects a missing userId', async () => {
    const { service } = makeService();
    await expect(service.getMyVerificationStatus({ userId: '' })).rejects.toThrow(UnauthorizedException);
  });

  it('returns status with no latest request', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      verifiedStatus: 'none',
      verifiedAt: null,
      unverifiedAt: null,
    });
    deps.prisma.verificationRequest.findFirst.mockResolvedValue(null);

    const result = await service.getMyVerificationStatus({ userId: 'u1' });

    expect(result.verifiedStatus).toBe('none');
    expect(result.latestRequest).toBeNull();
  });
});

describe('VerificationService.approveAdmin', () => {
  it('rejects an empty request id', async () => {
    const { service } = makeService();

    await expect(
      service.approveAdmin({ requestId: ' ', adminUserId: 'a1' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects when the request does not exist', async () => {
    const { service, deps } = makeService();
    deps.prisma.verificationRequest.findUnique.mockResolvedValue(null);

    await expect(
      service.approveAdmin({ requestId: 'vr1', adminUserId: 'a1' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects a non-pending request for an unverified user', async () => {
    const { service, deps } = makeService();
    deps.prisma.verificationRequest.findUnique.mockResolvedValue({
      id: 'vr1',
      status: 'rejected',
      userId: 'u1',
      user: { id: 'u1', verifiedStatus: 'none' },
    });

    await expect(
      service.approveAdmin({ requestId: 'vr1', adminUserId: 'a1' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('delegates to UserVerificationService and returns the refreshed request', async () => {
    const { service, deps } = makeService();
    deps.prisma.verificationRequest.findUnique.mockResolvedValue({
      id: 'vr1',
      status: 'pending',
      userId: 'u1',
      user: { id: 'u1', verifiedStatus: 'none' },
    });
    const updatedReq = {
      id: 'vr1',
      status: 'approved',
      userId: 'u1',
      user: { id: 'u1', username: 'alice' },
      reviewedByAdmin: { id: 'a1', username: 'admin', name: 'Admin' },
    };
    deps.prisma.verificationRequest.findUniqueOrThrow.mockResolvedValue(updatedReq);

    const result = await service.approveAdmin({ requestId: 'vr1', adminUserId: 'a1', adminNote: 'ok' });

    expect(deps.userVerification.verifyUser).toHaveBeenCalledWith({
      userId: 'u1',
      source: 'admin_request',
      requestId: 'vr1',
      adminUserId: 'a1',
      adminNote: 'ok',
      verifiedStatus: 'manual',
    });
    expect(result).toBe(updatedReq);
  });
});

describe('VerificationService.rejectAdmin', () => {
  it('requires a rejection reason', async () => {
    const { service } = makeService();

    await expect(
      service.rejectAdmin({ requestId: 'vr1', adminUserId: 'a1', rejectionReason: '  ' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a non-pending request', async () => {
    const { service, deps } = makeService();
    deps.prisma.__tx.verificationRequest.findUnique.mockResolvedValue({
      id: 'vr1',
      status: 'approved',
    });

    await expect(
      service.rejectAdmin({ requestId: 'vr1', adminUserId: 'a1', rejectionReason: 'nope' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a pending request and emits admin updated', async () => {
    const { service, deps } = makeService();
    deps.prisma.__tx.verificationRequest.findUnique.mockResolvedValue({
      id: 'vr1',
      status: 'pending',
    });
    const updated = {
      id: 'vr1',
      status: 'rejected',
      user: { id: 'u1' },
      reviewedByAdmin: { id: 'a1', username: 'admin', name: 'Admin' },
    };
    deps.prisma.__tx.verificationRequest.update.mockResolvedValue(updated);

    const result = await service.rejectAdmin({
      requestId: 'vr1',
      adminUserId: 'a1',
      rejectionReason: 'incomplete',
    });

    expect(result).toBe(updated);
    expect(deps.presenceRealtime.emitAdminUpdated).toHaveBeenCalledWith('a1', {
      kind: 'verification',
      action: 'reviewed',
      id: 'vr1',
    });
  });
});
