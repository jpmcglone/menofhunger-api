import { AdminImageReviewService } from './admin-image-review.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { PublicProfileCacheService } from '../users/public-profile-cache.service';

describe('profile and publication media ownership', () => {
  const key = 'announcements/notice.webp';
  const asset = { id: 'asset', r2Key: key, createdAt: new Date(), deletedAt: null };
  const setup = (assetKey = key) => {
    const indexedAsset = { ...asset, r2Key: assetKey };
    const prisma = {
      mediaAsset: { findUnique: jest.fn().mockResolvedValue(indexedAsset), findMany: jest.fn().mockResolvedValue([indexedAsset]) },
      postMedia: { findMany: jest.fn().mockResolvedValue([]) },
      messageMedia: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      communityGroup: { findMany: jest.fn().mockResolvedValue([]) },
      crew: { findMany: jest.fn().mockResolvedValue([]) },
      postPollOption: { findMany: jest.fn().mockResolvedValue([]) },
      article: { findMany: jest.fn().mockResolvedValue([]) },
      announcement: { findMany: jest.fn().mockResolvedValue([]) },
      avatarVideoUpload: { findMany: jest.fn().mockResolvedValue([]) },
      newsletter: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(),
    };
    const service = new AdminImageReviewService(
      prisma as unknown as PrismaService,
      { r2: () => null } as unknown as AppConfigService,
      { invalidateForUser: jest.fn() } as unknown as PublicProfileCacheService<{ id: string; username: string | null }>,
    );
    return { prisma, service };
  };

  const avatarVideoKey = 'avatars/user/video/version/avatar.mp4';
  const avatarPosterKey = 'avatars/user/video/version/poster.jpg';
  const avatarUser = {
    id: 'user', username: 'john', name: 'John', premium: false, premiumPlus: false,
    verifiedStatus: 'none', avatarKey: avatarPosterKey, avatarVideoKey, bannerKey: null,
  };

  it.each([
    ['photo', 'avatars/user/photo.webp'], ['video', avatarVideoKey], ['poster', avatarPosterKey],
  ])('keeps a current profile %s out of orphans without an upload record or paid tier', async (kind, assetKey) => {
    const { prisma, service } = setup(assetKey);
    prisma.user.findMany.mockResolvedValue([{ ...avatarUser,
      ...(kind === 'photo' ? { avatarKey: assetKey, avatarVideoKey: null } : {}),
    }]);
    // Upload bookkeeping can expire; the current profile remains the authoritative owner.
    const detail = await service.getById('asset');
    expect(detail.asset.primaryType).toBe('user');
    expect(detail.references.users).toEqual([expect.objectContaining({ id: 'user', isAvatar: true })]);
    const list = await service.list({ limit: 30, cursor: null, onlyOrphans: true });
    expect(list.items).toEqual([]);
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ avatarKey: { in: [assetKey] } }, { avatarVideoKey: { in: [assetKey] } }, { bannerKey: { in: [assetKey] } }] },
    }));
  });

  it.each(['queued', 'processing'].flatMap(status => ['sourceKey', 'videoKey', 'posterKey'].map(field => [status, field])))
  ('protects %s avatar job media referenced by %s', async (status, field) => {
    const keys: Record<string, string> = { sourceKey: 'avatars/user/video/version/source.mov', videoKey: avatarVideoKey, posterKey: avatarPosterKey };
    const { prisma, service } = setup(keys[field]);
    prisma.avatarVideoUpload.findMany.mockResolvedValue([{ ...keys, id: 'job', userId: 'user', user: avatarUser, status }]);
    expect((await service.getById('asset')).asset.primaryType).toBe('user');
    expect((await service.list({ limit: 30, cursor: null, onlyOrphans: true })).items).toEqual([]);
  });

  it.each([avatarVideoKey, avatarPosterKey])('rejects stale single and bulk orphan deletion after a profile adopts %s', async assetKey => {
    const { prisma, service } = setup(assetKey);
    expect((await service.getById('asset')).asset.primaryType).toBe('orphan');
    prisma.user.findMany.mockResolvedValue([avatarUser]);
    await expect(service.deleteById({ id: 'asset', adminUserId: 'admin', reason: 'Orphan cleanup', onlyOrphans: true }))
      .rejects.toThrow('no longer an orphan');
    const bulk = await service.deleteManyByIds({ ids: ['asset'], adminUserId: 'admin', reason: 'Orphan cleanup', onlyOrphans: true });
    expect(bulk.deleted).toBe(0);
    expect(bulk.errors).toHaveLength(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('classifies an unreferenced old avatar as an orphan instead of exempting the whole avatar prefix', async () => {
    const { service } = setup('avatars/user/video/replaced/avatar.mp4');
    expect((await service.getById('asset')).asset.primaryType).toBe('orphan');
    const list = await service.list({ limit: 30, cursor: null, onlyOrphans: true });
    expect(list.items).toEqual([expect.objectContaining({ id: 'asset', belongsToSummary: 'orphan' })]);
  });

  it.each(['draft', 'published', 'archived'])('recognizes %s announcement images and excludes them from orphans', async (status) => {
    const { prisma, service } = setup();
    prisma.announcement.findMany.mockResolvedValue([{ id: 'notice', title: 'Conference', status, imageKey: key }]);
    const detail = await service.getById('asset');
    expect(detail.asset.primaryType).toBe('announcement');
    expect(detail.references.announcements).toEqual([{ id: 'notice', title: 'Conference', status, isInline: false }]);
    const list = await service.list({ limit: 30, cursor: null, onlyOrphans: true });
    expect(list.items).toEqual([]);
    expect(prisma.announcement.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { imageKey: { in: [key] } } }));
  });

  it.each(['draft', 'scheduled', 'sent'])('protects %s newsletter cover and body images', async (status) => {
    const { prisma, service } = setup();
    prisma.newsletter.findMany.mockResolvedValue([
      { id: 'cover', subject: 'Cover', status, imageKey: key, bodyJson: '' },
      { id: 'inline', subject: 'Inline', status, imageKey: null, bodyJson: JSON.stringify({ type: 'image', attrs: { src: `https://cdn.example/${key}` } }) },
    ]);
    const detail = await service.getById('asset');
    expect(detail.asset.primaryType).toBe('newsletter');
    expect(detail.references.newsletters.map((ref) => [ref.id, ref.isInline])).toEqual([['cover', false], ['inline', true]]);
  });

  it('rechecks ownership before deleting a stale orphan selection, including bulk deletion', async () => {
    const { prisma, service } = setup();
    expect((await service.getById('asset')).asset.primaryType).toBe('orphan');
    prisma.announcement.findMany.mockResolvedValue([{ id: 'notice', title: 'New notice', status: 'draft', imageKey: key }]);
    await expect(service.deleteById({ id: 'asset', adminUserId: 'admin', reason: 'Orphan cleanup' })).rejects.toThrow('still used');
    const bulk = await service.deleteManyByIds({ ids: ['asset'], adminUserId: 'admin', reason: 'Orphan cleanup' });
    expect(bulk.deleted).toBe(0);
    expect(bulk.errors).toHaveLength(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('rejects an orphan-only delete when a profile starts using the asset', async () => {
    const { prisma, service } = setup();
    prisma.user.findMany.mockResolvedValue([{ id: 'user', username: 'john', avatarKey: key, bannerKey: null }]);
    await expect(service.deleteById({ id: 'asset', adminUserId: 'admin', reason: 'Orphan cleanup', onlyOrphans: true })).rejects.toThrow('no longer an orphan');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('finds legacy CDN references even in batches larger than forty assets', async () => {
    const { prisma, service } = setup();
    prisma.mediaAsset.findMany.mockResolvedValue(Array.from({ length: 45 }, (_, i) => ({ ...asset, id: `asset-${i}`, r2Key: `group-images/photo-${i}.webp` })));
    const legacyGroup = { id: 'group', slug: 'group', name: 'Group', avatarImageUrl: 'https://old-cdn.example/group-images/photo-44.webp?v=old', coverImageUrl: null };
    prisma.communityGroup.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([legacyGroup]);
    const result = await service.list({ limit: 50, cursor: null, onlyOrphans: true });
    expect(result.items).toHaveLength(44);
    expect(result.items.some((item) => item.id === 'asset-44')).toBe(false);
  });

});
