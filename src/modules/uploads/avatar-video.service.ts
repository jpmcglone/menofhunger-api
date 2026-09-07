import { BadRequestException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { UsersMeRealtimeService } from '../users/users-me-realtime.service';
import { UsersPublicRealtimeService } from '../users/users-public-realtime.service';
import { PublicProfileCacheService } from '../users/public-profile-cache.service';
import { toUserDto } from '../../common/dto/user.dto';
import { AVATAR_VIDEO_MAX_INPUT_BYTES, AVATAR_VIDEO_QUEUE, avatarVideoSelectionSchema, type AvatarVideoSelection } from './avatar-video-policy';
import { AvatarVideoTranscoder } from './avatar-video-transcoder';

@Injectable()
export class AvatarVideoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @InjectQueue(AVATAR_VIDEO_QUEUE) private readonly queue: Queue,
    private readonly transcoder: AvatarVideoTranscoder,
    private readonly me: UsersMeRealtimeService,
    private readonly profiles: UsersPublicRealtimeService,
    private readonly profileCache: PublicProfileCacheService<any>,
  ) {}

  async canSet(userId: string, operatorUserId?: string | null): Promise<boolean> {
    const target = await this.prisma.user.findUnique({ where: { id: userId }, select: { premium: true, premiumPlus: true, bannedAt: true } });
    if (!target || target.bannedAt) return false;
    if (operatorUserId && operatorUserId !== userId) {
      const membership = await this.prisma.userPageOperator.findFirst({ where: { pageUserId: userId, operatorUserId } });
      if (!membership) return false;
      const operator = await this.prisma.user.findUnique({ where: { id: operatorUserId }, select: { premium: true, premiumPlus: true, bannedAt: true } });
      return Boolean(operator && !operator.bannedAt && (operator.premium || operator.premiumPlus || target.premium || target.premiumPlus));
    }
    return Boolean(target.premium || target.premiumPlus);
  }

  private async authorize(userId: string, operatorUserId?: string | null) {
    if (!(await this.canSet(userId, operatorUserId))) throw new ForbiddenException('Video avatars require Premium or Premium Plus, including accounts you operate.');
  }

  private storage() {
    const config = this.config.r2();
    if (!config) throw new ServiceUnavailableException('Uploads are not configured yet.');
    return { bucket: config.bucket, client: new S3Client({ region: 'auto', endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } }) };
  }

  async init(userId: string, operatorUserId: string | null, contentType: string) {
    await this.authorize(userId, operatorUserId);
    const extension = ({ 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-m4v': 'm4v' } as Record<string, string>)[contentType];
    if (!extension) throw new BadRequestException('Choose an MP4, MOV, or WebM video.');
    const id = randomUUID();
    const prefix = `${this.config.isProd() ? '' : 'dev/'}avatars/${userId}/video/${id}`;
    const row = await this.prisma.$transaction(async tx => {
      const user = await tx.user.update({ where: { id: userId }, data: { avatarRevision: { increment: 1 } }, select: { avatarRevision: true } });
      return tx.avatarVideoUpload.create({ data: { id, userId, operatorUserId, revision: user.avatarRevision,
        sourceKey: `${prefix}/source.${extension}`, videoKey: `${prefix}/avatar.mp4`, posterKey: `${prefix}/poster.jpg` } });
    });
    const { client, bucket } = this.storage();
    try {
      const uploadUrl = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: row.sourceKey, ContentType: contentType }), { expiresIn: 900 });
      return { id, key: row.sourceKey, uploadUrl, headers: { 'Content-Type': contentType }, maxBytes: AVATAR_VIDEO_MAX_INPUT_BYTES };
    } finally { client.destroy(); }
  }

  private async owned(userId: string, id: string) {
    const row = await this.prisma.avatarVideoUpload.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException('Avatar upload not found.');
    return row;
  }

  async status(userId: string, id: string) {
    const row = await this.owned(userId, id);
    const user = row.status === 'ready' ? await this.prisma.user.findUniqueOrThrow({ where: { id: userId } }) : null;
    return { id: row.id, status: row.status, error: row.error, user: user ? toUserDto(user, this.config.r2()?.publicBaseUrl ?? null) : null };
  }

  async commit(userId: string, operatorUserId: string | null, id: string, selection: AvatarVideoSelection) {
    await this.authorize(userId, operatorUserId);
    const row = await this.owned(userId, id);
    if (row.operatorUserId !== operatorUserId) throw new ForbiddenException('Switch back to the account that started this upload.');
    if (row.status !== 'uploading' && row.status !== 'queued') return this.status(userId, id);
    const { client, bucket } = this.storage();
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: row.sourceKey }));
      if (!head.ContentLength || head.ContentLength > AVATAR_VIDEO_MAX_INPUT_BYTES) throw new BadRequestException('Video must be under 100 MB.');
    } finally { client.destroy(); }
    await this.prisma.avatarVideoUpload.updateMany({ where: { id, status: 'uploading' }, data: { status: 'queued', selection } });
    // A retry can repair enqueue failure without changing the immutable edit selection.
    await this.queue.add('process', { id }, { jobId: id, attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true, removeOnFail: { count: 50 } });
    return this.status(userId, id);
  }

  async cancel(userId: string, id: string) {
    const row = await this.owned(userId, id);
    if (row.status === 'ready') return this.status(userId, id);
    await this.prisma.$transaction(async tx => {
      const cancelled = await tx.avatarVideoUpload.updateMany({
        where: { id, status: { in: ['uploading', 'queued', 'processing'] } }, data: { status: 'cancelled' },
      });
      if (cancelled.count) await tx.user.updateMany({
        where: { id: userId, avatarRevision: row.revision ?? -1 }, data: { avatarRevision: { increment: 1 } },
      });
    });
    return this.status(userId, id);
  }

  async process(id: string) {
    const row = await this.prisma.avatarVideoUpload.findUnique({ where: { id } });
    if (!row || !['queued', 'processing'].includes(row.status)) return;
    const user = await this.prisma.user.findUnique({ where: { id: row.userId }, select: { avatarRevision: true, username: true } });
    if (user?.avatarRevision !== row.revision) {
      await this.prisma.avatarVideoUpload.update({ where: { id }, data: { status: 'superseded' } });
      return;
    }
    await this.authorize(row.userId, row.operatorUserId);
    const claimed = await this.prisma.avatarVideoUpload.updateMany({ where: { id, status: { in: ['queued', 'processing'] } }, data: { status: 'processing' } });
    if (!claimed.count) return;
    const directory = await mkdtemp(join(tmpdir(), 'moh-avatar-'));
    const { client, bucket } = this.storage();
    try {
      const input = join(directory, 'source');
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: row.sourceKey }));
      if (!response.Body) throw new Error('The uploaded video is missing.');
      let bytes = 0;
      const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > AVATAR_VIDEO_MAX_INPUT_BYTES ? new Error('Video must be under 100 MB.') : null, chunk);
      } });
      await pipeline(response.Body as NodeJS.ReadableStream, limit, createWriteStream(input), { signal: AbortSignal.timeout(60_000) });
      const output = await this.transcoder.transcode(input, directory, avatarVideoSelectionSchema.parse(row.selection));
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: row.videoKey, Body: output.video, ContentType: 'video/mp4', CacheControl: 'public, max-age=31536000, immutable' }));
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: row.posterKey, Body: output.poster, ContentType: 'image/jpeg', CacheControl: 'public, max-age=31536000, immutable' }));
      await this.authorize(row.userId, row.operatorUserId);
      const published = await this.prisma.$transaction(async tx => {
        const claimed = await tx.avatarVideoUpload.updateMany({ where: { id, status: 'processing' }, data: { status: 'publishing' } });
        if (!claimed.count) return false;
        const changed = await tx.user.updateMany({ where: { id: row.userId, avatarRevision: row.revision ?? -1 }, data: {
          avatarKey: row.posterKey, avatarVideoKey: row.videoKey, avatarVideoDurationMs: output.durationMs, avatarUpdatedAt: new Date(),
        } });
        await tx.avatarVideoUpload.update({ where: { id }, data: { status: changed.count ? 'ready' : 'superseded', error: null } });
        return changed.count > 0;
      });
      if (published) {
        await this.profileCache.invalidateForUser({ id: row.userId, username: user?.username ?? null });
        await this.me.emitMeUpdated(row.userId, 'avatar_changed');
        await this.profiles.emitPublicProfileUpdated(row.userId);
      }
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: row.sourceKey }));
    } finally { client.destroy(); await rm(directory, { recursive: true, force: true }); }
  }

  async fail(id: string) {
    await this.prisma.avatarVideoUpload.updateMany({ where: { id, status: { in: ['queued', 'processing'] } },
      data: { status: 'failed', error: 'Could not process this video. Try a different clip.' } });
  }

  /** Expire upload bookkeeping; published media remains under the central ownership resolver. */
  async expireUploads() {
    const rows = await this.prisma.avatarVideoUpload.findMany({
      where: { updatedAt: { lt: new Date(Date.now() - 7 * 86_400_000) } },
      orderBy: { updatedAt: 'asc' }, take: 100,
    });
    if (!rows.length) return;
    const { client, bucket } = this.storage();
    try {
      for (const row of rows) {
        if (!this.config.isProd() && !row.sourceKey.startsWith('dev/')) continue;
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: row.sourceKey }));
        // Do not delete posters/videos here: emails and other published references may retain them.
        await this.prisma.avatarVideoUpload.deleteMany({ where: { id: row.id, updatedAt: row.updatedAt } });
      }
    } finally { client.destroy(); }
  }
}
