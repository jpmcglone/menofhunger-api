import { VerifiedStatus } from '@prisma/client';
import { ViewerContextService } from './viewer-context.service';

function makeService() {
  const prisma = {} as any;
  const requestCache = { get: jest.fn(), set: jest.fn() } as any;
  return new ViewerContextService(prisma, requestCache);
}

describe('ViewerContextService.allowedPostVisibilities', () => {
  it('returns public only for anon', () => {
    const svc = makeService();
    expect(svc.allowedPostVisibilities(null)).toEqual(['public']);
  });

  it('includes verifiedOnly for verified viewers', () => {
    const svc = makeService();
    expect(
      svc.allowedPostVisibilities({
        verifiedStatus: VerifiedStatus.identity,
        premium: false,
        premiumPlus: false,
      } as any),
    ).toEqual(['public', 'verifiedOnly']);
  });

  it('includes premiumOnly for premium viewers', () => {
    const svc = makeService();
    expect(
      svc.allowedPostVisibilities({
        verifiedStatus: VerifiedStatus.none,
        premium: true,
        premiumPlus: false,
      } as any),
    ).toEqual(['public', 'premiumOnly']);
  });

  it('treats premiumPlus as premium for visibility', () => {
    const svc = makeService();
    expect(
      svc.allowedPostVisibilities({
        verifiedStatus: VerifiedStatus.none,
        premium: false,
        premiumPlus: true,
      } as any),
    ).toEqual(['public', 'premiumOnly']);
  });

  it('includes both verifiedOnly and premiumOnly when applicable', () => {
    const svc = makeService();
    expect(
      svc.allowedPostVisibilities({
        verifiedStatus: VerifiedStatus.identity,
        premium: false,
        premiumPlus: true,
      } as any),
    ).toEqual(['public', 'verifiedOnly', 'premiumOnly']);
  });
});

