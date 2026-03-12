import { ForbiddenException } from '@nestjs/common';
import { VerifiedStatus } from '@prisma/client';
import { ArticlesService } from './articles.service';

function makeService(opts?: { allowedVisibilities?: Array<'public' | 'verifiedOnly' | 'premiumOnly'> }) {
  const prisma = {
    article: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as any;

  const viewer = {
    getViewer: jest.fn().mockResolvedValue({
      id: 'viewer-1',
      verifiedStatus: VerifiedStatus.identity,
      premium: false,
      premiumPlus: false,
      siteAdmin: false,
    }),
    allowedPostVisibilities: jest.fn().mockReturnValue(opts?.allowedVisibilities ?? ['public']),
  } as any;

  const appConfig = {
    r2: jest.fn().mockReturnValue({ publicBaseUrl: 'https://cdn.example.com' }),
  } as any;

  const service = new ArticlesService(
    prisma,
    viewer,
    appConfig,
    {} as any,
    {} as any,
    {} as any,
  );

  return { service, prisma, viewer };
}

describe('ArticlesService.listPublished visibility filters', () => {
  it('rejects unauthorized verifiedOnly explicit filter when includeRestricted is false', async () => {
    const { service, prisma } = makeService({ allowedVisibilities: ['public'] });

    await expect(
      service.listPublished({
        viewerUserId: 'viewer-1',
        visibilityFilter: 'verifiedOnly',
        includeRestricted: false,
      }),
    ).rejects.toThrow(new ForbiddenException('Verify to view verified-only posts.'));

    expect(prisma.article.findMany).not.toHaveBeenCalled();
  });

  it('rejects unauthorized premiumOnly explicit filter when includeRestricted is false', async () => {
    const { service, prisma } = makeService({ allowedVisibilities: ['public', 'verifiedOnly'] });

    await expect(
      service.listPublished({
        viewerUserId: 'viewer-1',
        visibilityFilter: 'premiumOnly',
        includeRestricted: false,
      }),
    ).rejects.toThrow(new ForbiddenException('Upgrade to premium to view premium-only posts.'));

    expect(prisma.article.findMany).not.toHaveBeenCalled();
  });

  it('honors explicit visibility filter in restricted-preview mode', async () => {
    const { service, prisma } = makeService({ allowedVisibilities: ['public', 'verifiedOnly'] });

    await service.listPublished({
      viewerUserId: 'viewer-1',
      visibilityFilter: 'premiumOnly',
      includeRestricted: true,
    });

    expect(prisma.article.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.article.findMany.mock.calls[0]?.[0] ?? {};
    expect(call.where?.visibility).toBe('premiumOnly');
  });
});
