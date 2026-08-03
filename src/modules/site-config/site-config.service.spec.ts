import { SiteConfigService } from './site-config.service';

describe('SiteConfigService.shouldAutoVerify', () => {
  const service = new SiteConfigService({ siteConfig: { findUnique: jest.fn() } } as any);

  it('returns false when the toggle is off', () => {
    expect(
      service.shouldAutoVerify({ autoVerifyNewUsers: false, autoVerifyRecruiterId: null }, 'r1'),
    ).toBe(false);
  });

  it('returns true for any recruit when the toggle is on with no recruiter filter', () => {
    expect(
      service.shouldAutoVerify({ autoVerifyNewUsers: true, autoVerifyRecruiterId: null }, null),
    ).toBe(true);
    expect(
      service.shouldAutoVerify({ autoVerifyNewUsers: true, autoVerifyRecruiterId: null }, 'r1'),
    ).toBe(true);
  });

  it('returns true only for the matching recruiter when a filter is set', () => {
    expect(
      service.shouldAutoVerify({ autoVerifyNewUsers: true, autoVerifyRecruiterId: 'r1' }, 'r1'),
    ).toBe(true);
    expect(
      service.shouldAutoVerify({ autoVerifyNewUsers: true, autoVerifyRecruiterId: 'r1' }, 'r2'),
    ).toBe(false);
    expect(
      service.shouldAutoVerify({ autoVerifyNewUsers: true, autoVerifyRecruiterId: 'r1' }, null),
    ).toBe(false);
  });
});
