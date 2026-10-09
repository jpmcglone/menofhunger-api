import { S3Client } from '@aws-sdk/client-s3';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { AppConfigService } from '../app/app-config.service';
import { isProtectedChannelKey } from '../group-channels/channel-media.service';

/** The R2 client plus bucket, key-prefix, and public-URL rules for reviewed media. */
@Injectable()
export class AdminImageReviewStorageService {
  private readonly s3: S3Client | null;
  private readonly bucket: string | null;

  constructor(private readonly cfg: AppConfigService) {
    const r2 = this.cfg.r2();
    if (!r2) {
      this.s3 = null;
      this.bucket = null;
      return;
    }
    this.bucket = r2.bucket;
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: r2.accessKeyId,
        secretAccessKey: r2.secretAccessKey,
      },
    });
  }

  requireR2(): { s3: S3Client; bucket: string } {
    if (!this.s3 || !this.bucket) throw new ServiceUnavailableException('R2 is not configured.');
    return { s3: this.s3, bucket: this.bucket };
  }

  bucketForKey(key: string) {
    if (!isProtectedChannelKey(key)) return this.requireR2().bucket;
    const bucket = this.cfg.channelMediaBucket();
    if (!bucket) throw new ServiceUnavailableException('Private channel storage is not configured.');
    return bucket;
  }

  objectKeyPrefix() {
    return this.cfg.isProd() ? '' : 'dev/';
  }

  publicUrlForKey(key: string | null): string | null {
    if (key && isProtectedChannelKey(key)) return null;
    return publicAssetUrl({ publicBaseUrl: this.cfg.r2()?.publicBaseUrl ?? null, key });
  }
}
