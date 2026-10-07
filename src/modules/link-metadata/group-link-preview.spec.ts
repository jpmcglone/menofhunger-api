import { LinkMetadataService } from './link-metadata.service';

import { PostsReadService } from '../posts-read/posts-read.service';
function setup(user: unknown, group: unknown = null) {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(user) },
    communityGroup: { findFirst: jest.fn().mockResolvedValue(group) },
  };
  const service = new LinkMetadataService(prisma as any, {} as any, { frontendBaseUrl: () => 'https://menofhunger.com' } as any, new PostsReadService(prisma as any as never));
  return { service, prisma };
}
const group = { slug: 'men-of-hunger', name: 'Men of Hunger', description: 'Show up.', avatarImageUrl: 'a.png', coverImageUrl: null, memberCount: 12, joinPolicy: 'open' };
const url = 'https://menofhunger.com/g/men-of-hunger';

describe('group link previews', () => {
  it('recognizes group urls on Men of Hunger hosts only', () => {
    const { service } = setup(null);
    expect(service.groupSlugFromUrl(url)).toBe('men-of-hunger');
    expect(service.groupSlugFromUrl('https://menofhunger.com/groups/Men-Of-Hunger/channels/c1?message=m')).toBe('men-of-hunger');
    expect(service.groupSlugFromUrl('https://menofhunger.com/groups/new')).toBeNull();
    expect(service.groupSlugFromUrl('https://example.com/g/men-of-hunger')).toBeNull();
  });

  it('locks the card for signed-out viewers without reading the group', async () => {
    const { service, prisma } = setup(null, group);
    const meta = await service.getGroupPreview(url, 'men-of-hunger', null);
    expect(meta.locked).toBe('signIn');
    expect(meta.group).toBeNull();
    expect(prisma.communityGroup.findFirst).not.toHaveBeenCalled();
  });

  it('locks the card for unverified viewers', async () => {
    const { service, prisma } = setup({ verifiedStatus: 'none' }, group);
    const meta = await service.getGroupPreview(url, 'men-of-hunger', 'u1');
    expect(meta.locked).toBe('verify');
    expect(meta.title).toBe('Group');
    expect(prisma.communityGroup.findFirst).not.toHaveBeenCalled();
  });

  it('returns the rich card for verified viewers', async () => {
    const { service } = setup({ verifiedStatus: 'identity' }, group);
    const meta = await service.getGroupPreview(url, 'men-of-hunger', 'u1');
    expect(meta.locked).toBeNull();
    expect(meta.group).toMatchObject({ name: 'Men of Hunger', memberCount: 12, joinPolicy: 'open' });
  });
});
