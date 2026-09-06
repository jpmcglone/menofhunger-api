import { VerificationController } from './verification.controller';
import type { VerificationService } from './verification.service';

describe('verification video-call consent', () => {
  const request = { id: 'request', status: 'pending', createdAt: new Date(), updatedAt: new Date(), provider: 'moh_video_call' };
  const service = { createRequestForUser: jest.fn(async () => request) };
  const controller = new VerificationController(service as unknown as VerificationService);
  beforeEach(() => jest.clearAllMocks());

  it('records explicit acknowledgment on the request', async () => {
    await controller.createRequest({ videoCallConsent: true }, 'member');
    expect(service.createRequestForUser).toHaveBeenCalledWith({ userId: 'member', providerHint: 'moh_video_call' });
  });

  it('rejects a submitted refusal instead of recording agreement', async () => {
    await expect(controller.createRequest({ videoCallConsent: false }, 'member')).rejects.toThrow();
    expect(service.createRequestForUser).not.toHaveBeenCalled();
  });

  it('keeps old app requests distinct from acknowledged video calls', async () => {
    await controller.createRequest({}, 'member');
    expect(service.createRequestForUser).toHaveBeenCalledWith({ userId: 'member', providerHint: null });
  });
});
