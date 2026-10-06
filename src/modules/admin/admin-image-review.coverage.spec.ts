import { Prisma } from '@prisma/client';

// Deliberately explicit: new media-bearing schema fields must receive an ownership
// resolver and deletion policy, rather than silently becoming orphan candidates.
const reviewedMediaFields = new Set([
  'User.avatarKey', 'User.bannerKey', 'User.avatarVideoKey',
  'AvatarVideoUpload.sourceKey', 'AvatarVideoUpload.videoKey', 'AvatarVideoUpload.posterKey',
  'CommunityGroup.avatarImageUrl', 'CommunityGroup.coverImageUrl',
  'Crew.avatarImageUrl', 'Crew.coverImageUrl',
  'PostPollOption.imageR2Key',
  'PostMedia.r2Key', 'PostMedia.thumbnailR2Key', 'PostMedia.mp4Url',
  'MessageMedia.r2Key', 'MessageMedia.thumbnailR2Key', 'MessageMedia.mp4Url',
  'Article.thumbnailR2Key', 'Announcement.imageKey', 'Newsletter.imageKey',
  // Asset inventory/deduplication are not ownership. mp4Url above is provider GIF media.
  'MediaAsset.r2Key', 'MediaContentHash.r2Key',
  'GroupChannelUpload.sourceKey', 'GroupChannelUpload.r2Key',
  // External OpenGraph metadata is provider-hosted, not an upload surface.
  'LinkMetadata.imageUrl',
]);

// Explicit JSON review for integrations: none introduces an owned R2 derivative.
// Pickax profile images are constrained to img.pickax.com/user-*/ assets; no owned R2 media.
// X images are constrained to pbs.twimg.com in XPublicSnapshotService; delivery
// plans carry reviewed text/remote IDs/source hashes and retain media through PostMedia.
// Admin control audit payloads contain numeric ceilings and a pause flag only.
const reviewedIntegrationJsonFields = new Set([
  'IntegrationPublicSnapshot.payload', 'XCrosspost.deliveryPlan',
  'IntegrationControlAudit.before', 'IntegrationControlAudit.after',
]);

describe('media ownership schema coverage', () => {
  it('keeps integration JSON storage explicitly reviewed for media ownership', () => {
    const models = new Set(['IntegrationPublicSnapshot', 'XCrosspost', 'IntegrationControlAudit']);
    const fields = Prisma.dmmf.datamodel.models.filter(model => models.has(model.name))
      .flatMap(model => model.fields.filter(field => field.type === 'Json').map(field => `${model.name}.${field.name}`));
    expect(fields.filter(field => !reviewedIntegrationJsonFields.has(field))).toEqual([]);
  });
  it('requires review of every media key/URL field added to the schema', () => {
    const mediaFields = Prisma.dmmf.datamodel.models.flatMap((model) => model.fields
      .filter((field) => field.type === 'String' && /(?:r2Key|thumbnailR2Key|imageR2Key|imageKey|imageUrl|avatarKey|avatarVideoKey|sourceKey|videoKey|posterKey|bannerKey|avatarImageUrl|coverImageUrl|mp4Url)$/i.test(field.name))
      .map((field) => `${model.name}.${field.name}`));
    expect(mediaFields.filter((field) => !reviewedMediaFields.has(field))).toEqual([]);
  });
});
