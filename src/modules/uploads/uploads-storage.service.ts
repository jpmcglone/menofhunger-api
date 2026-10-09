import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { imageSize } from 'image-size';
import { AppConfigService } from '../app/app-config.service';
import { ImageProcessingGate } from './image-processing-gate';
import { normalizeJpegOrientationIfNeeded } from './uploads-jpeg-orientation';
import { streamToBuffer } from './uploads.constants';

/** The R2 client, key prefix, and bounded image inspection shared by every upload flow. */
@Injectable()
export class UploadsStorageService {
  private readonly s3: S3Client | null;
  private readonly bucket: string | null;
  private readonly imageProcessing = new ImageProcessingGate();

  constructor(private readonly appConfig: AppConfigService) {
    const r2 = this.appConfig.r2();
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

  requireR2() {
    if (!this.s3 || !this.bucket) {
      throw new ServiceUnavailableException('Uploads are not configured yet.');
    }
    return { s3: this.s3, bucket: this.bucket };
  }

  objectKeyPrefix() {
    // Keep prod keys stable; segregate dev/staging keys to avoid collisions.
    return this.appConfig.isProd() ? '' : 'dev/';
  }

  async getImageInfoAndNormalizeJpegIfNeeded(params: {
    s3: S3Client;
    bucket: string;
    key: string;
    contentType: string;
    maxBytes: number;
    cacheControl: string;
  }): Promise<{ width: number | null; height: number | null; bytes: number; didNormalize: boolean }> {
    return this.imageProcessing.run(() => this.readImageInfoAndNormalizeJpegIfNeeded(params));
  }

  private async readImageInfoAndNormalizeJpegIfNeeded(params: {
    s3: S3Client;
    bucket: string;
    key: string;
    contentType: string;
    maxBytes: number;
    cacheControl: string;
  }): Promise<{ width: number | null; height: number | null; bytes: number; didNormalize: boolean }> {
    const { s3, bucket, key, contentType, maxBytes, cacheControl } = params;
    const ct = (contentType ?? '').trim().toLowerCase();

    if (ct === 'image/jpeg') {
      return await normalizeJpegOrientationIfNeeded({ s3, bucket, key, maxBytes, cacheControl });
    }

    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = obj.Body;
    if (!body) throw new BadRequestException('Unable to read uploaded image.');
    const buf = await streamToBuffer(body, maxBytes);
    const dims = imageSize(buf);
    const w = dims.width ?? null;
    const h = dims.height ?? null;
    return {
      width: typeof w === 'number' ? Math.max(1, Math.floor(w)) : null,
      height: typeof h === 'number' ? Math.max(1, Math.floor(h)) : null,
      bytes: buf.length,
      didNormalize: false,
    };
  }
}
