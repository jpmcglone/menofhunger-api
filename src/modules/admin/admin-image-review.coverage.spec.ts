import { Prisma } from '@prisma/client';

// Deliberately explicit: new media-bearing schema fields must receive an ownership
// resolver and deletion policy, rather than silently becoming orphan candidates.
const reviewedMediaFields = new Set([
  'User.avatarKey', 'User.bannerKey',
  'CommunityGroup.avatarImageUrl', 'CommunityGroup.coverImageUrl',
  'Crew.avatarImageUrl', 'Crew.coverImageUrl',
  'PostPollOption.imageR2Key',
  'PostMedia.r2Key', 'PostMedia.thumbnailR2Key', 'PostMedia.mp4Url',
  'MessageMedia.r2Key', 'MessageMedia.thumbnailR2Key', 'MessageMedia.mp4Url',
  'Article.thumbnailR2Key', 'Announcement.imageKey', 'Newsletter.imageKey',
  // Asset inventory/deduplication are not ownership. mp4Url above is provider GIF media.
  'MediaAsset.r2Key', 'MediaContentHash.r2Key',
  // External OpenGraph metadata is provider-hosted, not an upload surface.
  'LinkMetadata.imageUrl',
]);

describe('media ownership schema coverage', () => {
  it('requires review of every media key/URL field added to the schema', () => {
    const mediaFields = Prisma.dmmf.datamodel.models.flatMap((model) => model.fields
      .filter((field) => field.type === 'String' && /(?:r2Key|thumbnailR2Key|imageR2Key|imageKey|imageUrl|avatarKey|bannerKey|avatarImageUrl|coverImageUrl|mp4Url)$/i.test(field.name))
      .map((field) => `${model.name}.${field.name}`));
    expect(mediaFields.filter((field) => !reviewedMediaFields.has(field))).toEqual([]);
  });
});
