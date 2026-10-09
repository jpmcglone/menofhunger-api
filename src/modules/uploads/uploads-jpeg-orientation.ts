import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BadRequestException } from '@nestjs/common';
import { imageSize } from 'image-size';
import sharp, { type Metadata as SharpMetadata } from 'sharp';
import { streamToBuffer } from './uploads.constants';

/**
 * Some phone photos are stored "sideways" with EXIF orientation metadata.
 * Browsers often display them correctly, but link unfurlers (iMessage/OG crawlers) may not.
 * Normalize JPEGs by applying orientation to pixels and stripping EXIF.
 */
export async function normalizeJpegOrientationIfNeeded(params: {
  s3: S3Client;
  bucket: string;
  key: string;
  maxBytes: number;
  cacheControl: string;
}): Promise<{ width: number | null; height: number | null; bytes: number; didNormalize: boolean }> {
  const { s3, bucket, key, maxBytes, cacheControl } = params;

  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = obj.Body;
  if (!body) throw new BadRequestException('Unable to read uploaded image.');
  const buf = await streamToBuffer(body, maxBytes);

  // Check if EXIF orientation requires normalization.
  let meta: SharpMetadata;
  try {
    meta = await sharp(buf, { failOn: 'none' }).metadata();
  } catch {
    // If sharp can't read metadata, fall back to using the original bytes.
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

  const orientation = typeof meta.orientation === 'number' ? meta.orientation : null;
  if (!orientation || orientation === 1) {
    const w = typeof meta.width === 'number' ? meta.width : null;
    const h = typeof meta.height === 'number' ? meta.height : null;
    return {
      width: w && w > 0 ? w : null,
      height: h && h > 0 ? h : null,
      bytes: buf.length,
      didNormalize: false,
    };
  }

  // Compressed bytes do not bound decoded memory (a small JPEG can be 48MP).
  // Older clients still need rotation; keep that fallback within a single bounded job.
  if ((meta.width ?? 0) * (meta.height ?? 0) > 64_000_000) {
    throw new BadRequestException('Please resize this photo to 64 megapixels or smaller.');
  }
  const rotated = await sharp(buf, { failOn: 'none', limitInputPixels: 64_000_000 })
    .rotate()
    .resize({ width: 3840, height: 3840, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 92 })
    .toBuffer({ resolveWithObject: true });

  const out = rotated.data;
  const w = rotated.info?.width ?? null;
  const h = rotated.info?.height ?? null;
  if (out.length > maxBytes) {
    throw new BadRequestException('Uploaded file is too large.');
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: out,
      ContentType: 'image/jpeg',
      CacheControl: cacheControl,
    }),
  );

  return {
    width: typeof w === 'number' && w > 0 ? w : null,
    height: typeof h === 'number' && h > 0 ? h : null,
    bytes: out.length,
    didNormalize: true,
  };
}
