import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { imageSize } from 'image-size';
import type { Prisma, PostMediaKind } from '@prisma/client';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelAccessService } from './channel-access.service';
import { assertChannelSend } from './channel-policy';
import { probeChannelMedia } from './channel-media-probe';

const TYPES: Record<string, { ext: string; kind: PostMediaKind }> = {
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/png': { ext: 'png', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'image/gif': { ext: 'gif', kind: 'gif' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'video/quicktime': { ext: 'mov', kind: 'video' },
  'video/webm': { ext: 'webm', kind: 'video' },
  'video/x-m4v': { ext: 'm4v', kind: 'video' },
  'audio/mp4': { ext: 'm4a', kind: 'audio' },
  'audio/m4a': { ext: 'm4a', kind: 'audio' },
  'audio/x-m4a': { ext: 'm4a', kind: 'audio' },
  'audio/aac': { ext: 'aac', kind: 'audio' },
  'audio/wav': { ext: 'wav', kind: 'audio' },
};

export function channelMediaLimits(kind: PostMediaKind, user: { premium: boolean; premiumPlus: boolean }) {
  if (kind === 'video') {
    if (!user.premium && !user.premiumPlus) throw new ForbiddenException('Video uploads are for premium members only.');
    return { bytes: (user.premiumPlus ? 500 : 250) * 1024 * 1024, duration: user.premiumPlus ? 900 : 300 };
  }
  return kind === 'audio' ? { bytes: 10 * 1024 * 1024, duration: 120 } : { bytes: 12 * 1024 * 1024, duration: null };
}

export function isProtectedChannelKey(key: string) {
  return /^(?:dev\/)?channel-uploads\//.test(key);
}

@Injectable()
export class ChannelMediaService {
  private readonly s3: S3Client | null;
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ChannelAccessService,
    private readonly config: AppConfigService,
  ) {
    const r2 = config.r2();
    this.s3 = r2
      ? new S3Client({
          region: 'auto',
          endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
          credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
        })
      : null;
  }
  private storage() {
    const bucket = this.config.channelMediaBucket();
    if (!this.s3 || !bucket) throw new ServiceUnavailableException('Channel uploads are not configured yet.');
    return { s3: this.s3, bucket };
  }

  async initialize(userId: string, groupId: string, channelId: string, input: { contentType: string; bytes: number }) {
    const { channel, member } = await this.access.channel(userId, groupId, channelId);
    assertChannelSend(channel, member.role);
    const { s3, bucket } = this.storage();
    const type = TYPES[input.contentType];
    if (!type) throw new BadRequestException('Choose an image, GIF, video or audio note.');
    const limit = channelMediaLimits(type.kind, member.user);
    if (input.bytes < 1 || input.bytes > limit.bytes) throw new BadRequestException('This file is too large.');
    const uploadId = randomUUID();
    const directory = `${this.config.isProd() ? '' : 'dev/'}channel-uploads/${userId}/${channelId}/${uploadId}`;
    const sourceKey = `${directory}/source.${type.ext}`;
    const r2Key = `${directory}/original.${type.ext}`;
    await this.prisma.$transaction(async (tx) => {
      await this.access.lockGroup(tx, groupId);
      const current = await this.access.channel(userId, groupId, channelId, tx);
      assertChannelSend(current.channel, current.member.role);
      await tx.groupChannelUpload.create({
        data: {
          id: uploadId,
          userId,
          channelId,
          sourceKey,
          r2Key,
          contentType: input.contentType,
          kind: type.kind,
          bytes: input.bytes,
          expiresAt: new Date(Date.now() + 7 * 86400_000),
        },
      });
    });
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: bucket,
        Key: sourceKey,
        ContentType: input.contentType,
        ContentLength: input.bytes,
        CacheControl: 'private, no-store',
      }),
      { expiresIn: 300 },
    );
    return {
      uploadId,
      uploadUrl,
      headers: { 'Content-Type': input.contentType, 'Cache-Control': 'private, no-store' },
      maxBytes: limit.bytes,
    };
  }

  async commit(userId: string, groupId: string, channelId: string, uploadId: string, input: { width?: number; height?: number; durationSeconds?: number }) {
    const { channel, member } = await this.access.channel(userId, groupId, channelId);
    assertChannelSend(channel, member.role);
    const { s3, bucket } = this.storage();
    const upload = await this.prisma.groupChannelUpload.findFirst({
      where: { id: uploadId, userId, channelId, expiresAt: { gt: new Date() } },
    });
    if (!upload) throw new NotFoundException('Upload unavailable.');
    if (upload.committedAt)
      return {
        uploadId: upload.id,
        kind: upload.kind,
        width: upload.width,
        height: upload.height,
        durationSeconds: upload.durationSeconds,
      };
    const limits = channelMediaLimits(upload.kind, member.user);
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: upload.sourceKey }));
    if (head.ContentLength !== upload.bytes || upload.bytes > limits.bytes || head.ContentType !== upload.contentType)
      throw new BadRequestException('The uploaded file does not match this upload.');
    let width = input.width ?? null;
    let height = input.height ?? null;
    let durationSeconds: number | null = null;
    if (upload.kind === 'audio' || upload.kind === 'video') {
      const original = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: upload.sourceKey, IfMatch: head.ETag }));
      if (!original.Body) throw new BadRequestException('The uploaded media is empty.');
      const inspected = await probeChannelMedia(original.Body as AsyncIterable<Uint8Array>, upload.kind, limits.bytes, limits.duration!);
      width = inspected.width;
      height = inspected.height;
      durationSeconds = inspected.durationSeconds;
    }
    if (upload.kind === 'image' || upload.kind === 'gif') {
      const original = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: upload.sourceKey, IfMatch: head.ETag }));
      if (!original.Body) throw new BadRequestException('The uploaded image is empty.');
      try {
        const dimensions = imageSize(await original.Body.transformToByteArray());
        width = dimensions.width;
        height = dimensions.height;
      } catch {
        throw new BadRequestException('The uploaded image could not be read.');
      }
    }
    if (upload.kind === 'video' && (!width || !height)) throw new BadRequestException('Video dimensions are required.');
    // Serialize finalization with sends and revocation. The initialized ownership row protects
    // both keys from orphan cleanup before the copy, and a committed key is never overwritten.
    const committed = await this.prisma.$transaction(
      async (tx) => {
        await this.access.lockGroup(tx, groupId);
        const current = await this.access.channel(userId, groupId, channelId, tx);
        assertChannelSend(current.channel, current.member.role);
        const latest = await tx.groupChannelUpload.findFirst({
          where: { id: uploadId, userId, channelId, expiresAt: { gt: new Date() } },
        });
        if (!latest) throw new NotFoundException('Upload unavailable.');
        if (latest.committedAt) return latest;
        await s3.send(
          new CopyObjectCommand({
            Bucket: bucket,
            Key: upload.r2Key,
            CopySource: `${bucket}/${encodeURIComponent(upload.sourceKey).replace(/%2F/g, '/')}`,
            CopySourceIfMatch: head.ETag,
            MetadataDirective: 'REPLACE',
            ContentType: upload.contentType,
            CacheControl: 'private, no-store',
          }),
        );
        const saved = await tx.groupChannelUpload.update({
          where: { id: uploadId },
          data: { committedAt: new Date(), width, height, durationSeconds },
        });
        await tx.mediaAsset.upsert({
          where: { r2Key: upload.r2Key },
          create: {
            r2Key: upload.r2Key,
            contentType: upload.contentType,
            bytes: upload.bytes,
            kind: upload.kind,
            width,
            height,
            r2LastModified: new Date(),
          },
          update: {},
        });
        return saved;
      },
      { timeout: 30_000 },
    );
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: upload.sourceKey }));
    return {
      uploadId,
      kind: committed.kind,
      width: committed.width,
      height: committed.height,
      durationSeconds: committed.durationSeconds,
    };
  }

  async consume(
    tx: Prisma.TransactionClient,
    userId: string,
    channelId: string,
    uploadId: string,
    thumbnailUploadId?: string,
  ): Promise<{
    source: 'upload';
    kind: PostMediaKind;
    r2Key: string;
    thumbnailR2Key: string | null;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
  }> {
    const upload = await tx.groupChannelUpload.findFirst({
      where: {
        id: uploadId,
        userId,
        channelId,
        committedAt: { not: null },
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!upload) throw new BadRequestException('Upload unavailable. Attach the file again.');
    const sender = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { premium: true, premiumPlus: true },
    });
    channelMediaLimits(upload.kind, sender);
    const deleted = await tx.mediaAsset.findUnique({ where: { r2Key: upload.r2Key }, select: { deletedAt: true } });
    if (deleted?.deletedAt) throw new BadRequestException('This upload is no longer available.');
    let thumbnailR2Key: string | null = null;
    if (thumbnailUploadId) {
      if (thumbnailUploadId === uploadId || upload.kind !== 'video') throw new BadRequestException('Invalid thumbnail.');
      const thumbnail = await this.consume(tx, userId, channelId, thumbnailUploadId);
      if (thumbnail.kind !== 'image') throw new BadRequestException('Thumbnail must be an image.');
      thumbnailR2Key = thumbnail.r2Key;
    }
    await tx.groupChannelUpload.update({ where: { id: uploadId }, data: { consumedAt: new Date() } });
    return {
      source: 'upload' as const,
      kind: upload.kind,
      r2Key: upload.r2Key,
      thumbnailR2Key,
      width: upload.width,
      height: upload.height,
      durationSeconds: upload.durationSeconds,
    };
  }

  /** Only called by the AdminGuard-protected report evidence endpoint. No channel browsing grant. */
  async readReportedMedia(reportId: string, mediaId: string, thumbnail: boolean, range?: string) {
    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
      select: { subjectMessageId: true, targetType: true },
    });
    if (report?.targetType !== 'message' || !report.subjectMessageId) throw new NotFoundException('Reported media unavailable.');
    const media = await this.prisma.messageMedia.findFirst({
      where: { id: mediaId, messageId: report.subjectMessageId, source: 'upload' },
    });
    const key = thumbnail ? media?.thumbnailR2Key : media?.r2Key;
    if (!key || !isProtectedChannelKey(key)) throw new NotFoundException('Reported media unavailable.');
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw new BadRequestException('Invalid media range.');
    const { s3, bucket } = this.storage();
    return this.readObject(s3, bucket, key, range);
  }

  async read(userId: string, groupId: string, channelId: string, mediaId: string, thumbnail: boolean, range?: string) {
    const { channel } = await this.access.channel(userId, groupId, channelId);
    const media = await this.prisma.messageMedia.findFirst({
      where: {
        id: mediaId,
        source: 'upload',
        message: { conversationId: channel.conversationId, deletedForAll: false },
      },
    });
    const key = thumbnail ? media?.thumbnailR2Key : media?.r2Key;
    if (!key || !isProtectedChannelKey(key)) throw new NotFoundException('Media unavailable.');
    const asset = await this.prisma.mediaAsset.findUnique({ where: { r2Key: key }, select: { deletedAt: true } });
    if (asset?.deletedAt) throw new NotFoundException('Media unavailable.');
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw new BadRequestException('Invalid media range.');
    const { s3, bucket } = this.storage();
    const object = await this.readObject(s3, bucket, key, range);
    try {
      await this.access.channel(userId, groupId, channelId);
    } catch (error) {
      (object.Body as { destroy?: () => void } | undefined)?.destroy?.();
      throw error;
    }
    return object;
  }
  private async readObject(s3: S3Client, bucket: string, key: string, range?: string) {
    try {
      return await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }));
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'InvalidRange') throw new HttpException('Requested range is unavailable.', 416);
      if (name === 'NoSuchKey' || name === 'NotFound') throw new NotFoundException('Media unavailable.');
      throw error;
    }
  }
}
