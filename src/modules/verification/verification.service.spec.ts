import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { VerificationService } from './verification.service';

type Deps = {
  prisma: any;
  slack: any;
  presenceRealtime: any;
  publicProfileCache: any;
  usersMeRealtime: any;
  usersPublicRealtime: any;
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
        findMany: jest.fn(async () => []),
        create: jest.fn(),
      },
      $transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) => fn(tx)),
      __tx: tx,
    },
    slack: { notifyVerificationRequested: jest.fn() },
    presenceRealtime: { emitAdminUpdated: jest.fn() },
    publicProfileCache: { invalidateForUser: jest.fn(async () => undefined) },
    usersMeRealtime: { emitMeUpdated: jest.fn(async () => undefined) },
    usersPublicRealtime: { emitPublicProfileUpdated: jest.fn(async () => undefined) },
    ...overrides,
  };
}

function makeService(overrides: Partial<Deps> = {}) {
  const deps = makeDeps(overrides);
  const service = new VerificationService(
    deps.prisma,
    deps.slack,
    deps.presenceRealtime,
    deps.publicProfileCache,
    deps.usersMeRealtime,
    deps.usersPublicRealtime,
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
    expect(deps.slack.notifyVerificationRequested).not.toHaveBeenCalled();
  });

  it('creates a request, truncates the provider hint, and notifies Slack', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({ id: 'u1', verifiedStatus: 'none' });
    deps.prisma.verificationRequest.findFirst.mockResolvedValue(null);
    const created = { id: 'vr2', status: 'pending' };
    deps.prisma.verificationRequest.create.mockResolvedValue(created);

    const longHint = 'x'.repeat(80);
    const result = await service.createRequestForUser({ userId: 'u1', providerHint: longHint });

    expect(result).toBe(created);
    expect(deps.prisma.verificationRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'pending',
          provider: 'x'.repeat(50),
        }),
      }),
    );
    expect(deps.slack.notifyVerificationRequested).toHaveBeenCalledWith({
      userId: 'u1',
      providerHint: 'x'.repeat(50),
    });
  });
});

describe('VerificationService.getMyVerificationStatus', () => {
  it('rejects a missing userId', async () => {
    const { service } = makeService();

    await expect(service.getMyVerificationStatus({ userId: null })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('returns status with the latest request serialized to ISO strings', async () => {
    const { service, deps } = makeService();
    const verifiedAt = new Date('2030-01-01T00:00:00Z');
    deps.prisma.user.findUnique.mockResolvedValue({
      verifiedStatus: 'manual',
      verifiedAt,
      unverifiedAt: null,
    });
    deps.prisma.verificationRequest.findFirst.mockResolvedValue({
      id: 'vr1',
      createdAt: new Date('2029-12-30T00:00:00Z'),
      updatedAt: new Date('2029-12-31T00:00:00Z'),
      status: 'approved',
      provider: 'manual',
      providerRequestId: null,
      reviewedAt: verifiedAt,
      rejectionReason: null,
    });

    const result = await service.getMyVerificationStatus({ userId: 'u1' });

    expect(result.verifiedStatus).toBe('manual');
    expect(result.verifiedAt).toBe('2030-01-01T00:00:00.000Z');
    expect(result.unverifiedAt).toBeNull();
    expect(result.latestRequest).toEqual(
      expect.objectContaining({
        id: 'vr1',
        status: 'approved',
        reviewedAt: '2030-01-01T00:00:00.000Z',
      }),
    );
  });

  it('returns a null latestRequest when the user has never requested', async () => {
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
    deps.prisma.__tx.verificationRequest.findUnique.mockResolvedValue(null);

    await expect(
      service.approveAdmin({ requestId: 'vr1', adminUserId: 'a1' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects a non-pending request for an unverified user', async () => {
    const { service, deps } = makeService();
    deps.prisma.__tx.verificationRequest.findUnique.mockResolvedValue({
      id: 'vr1',
      status: 'rejected',
      user: { id: 'u1', verifiedStatus: 'none' },
    });

    await expect(
      service.approveAdmin({ requestId: 'vr1', adminUserId: 'a1' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('approves a pending request, marks the user manual, and emits realtime updates', async () => {
    const { service, deps } = makeService();
    const tx = deps.prisma.__tx;
    tx.verificationRequest.findUnique.mockResolvedValue({
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
    tx.verificationRequest.update.mockResolvedValue(updatedReq);

    const result = await service.approveAdmin({ requestId: 'vr1', adminUserId: 'a1' });

    expect(result).toBe(updatedReq);
    expect(tx.verificationRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'vr1' },
        data: expect.objectContaining({ status: 'approved', provider: 'manual' }),
      }),
    );
    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({ verifiedStatus: 'manual', unverifiedAt: null }),
      }),
    );
    expect(deps.publicProfileCache.invalidateForUser).toHaveBeenCalledWith({
      id: 'u1',
      username: 'alice',
    });
    expect(deps.presenceRealtime.emitAdminUpdated).toHaveBeenCalledWith('a1', {
      kind: 'verification',
      action: 'reviewed',
      id: 'vr1',
    });
    expect(deps.usersPublicRealtime.emitPublicProfileUpdated).toHaveBeenCalledWith('u1');
    expect(deps.usersMeRealtime.emitMeUpdated).toHaveBeenCalledWith('u1', 'verification_status_changed');
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

  it('rejects a pending request with the reason and emits the admin event', async () => {
    const { service, deps } = makeService();
    const tx = deps.prisma.__tx;
    tx.verificationRequest.findUnique.mockResolvedValue({ id: 'vr1', status: 'pending' });
    const updated = { id: 'vr1', status: 'rejected' };
    tx.verificationRequest.update.mockResolvedValue(updated);

    const result = await service.rejectAdmin({
      requestId: 'vr1',
      adminUserId: 'a1',
      rejectionReason: 'Photo unclear',
    });

    expect(result).toBe(updated);
    expect(tx.verificationRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'vr1' },
        data: expect.objectContaining({ status: 'rejected', rejectionReason: 'Photo unclear' }),
      }),
    );
    expect(deps.presenceRealtime.emitAdminUpdated).toHaveBeenCalledWith('a1', {
      kind: 'verification',
      action: 'reviewed',
      id: 'vr1',
    });
  });
});
