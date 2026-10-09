import { BadRequestException } from '@nestjs/common';

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5MB
export const MAX_BANNER_BYTES = 8 * 1024 * 1024; // 8MB
export const MAX_POST_MEDIA_BYTES = 12 * 1024 * 1024; // 12MB per attachment
// Video uploads are premium-only; premium+ gets higher caps.
// NOTE: We don't transcode yet, but mobile devices increasingly produce large 4K files.
// Use a practical cap that avoids "upload forever then fail" while still allowing modern devices.
export const MAX_POST_VIDEO_BYTES_PREMIUM = 250 * 1024 * 1024; // 250MB
export const MAX_POST_VIDEO_BYTES_PREMIUM_PLUS = 500 * 1024 * 1024; // 500MB
export const MAX_POST_VIDEO_DURATION_SECONDS_PREMIUM = 5 * 60; // 5 minutes
export const MAX_POST_VIDEO_DURATION_SECONDS_PREMIUM_PLUS = 15 * 60; // 15 minutes
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10MB voice notes
export const MAX_AUDIO_DURATION_SECONDS = 120;
export const MAX_VOICEMAIL_BYTES = 25 * 1024 * 1024;
export const MAX_VOICEMAIL_DURATION_SECONDS = 60;
export const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const ALLOWED_AUDIO_CONTENT_TYPES = new Set([
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
]);
export const ALLOWED_POST_MEDIA_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  // iOS commonly uploads .mov as video/quicktime
  'video/quicktime',
  // Common in browsers / some Android encoders
  'video/webm',
  // Some devices label MP4 variants as m4v
  'video/x-m4v',
  ...ALLOWED_AUDIO_CONTENT_TYPES,
]);
export const ALLOWED_THUMBNAIL_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const BANNER_ASPECT_RATIO = 3; // 3:1
export const MIN_BANNER_WIDTH = 600;
export const MIN_BANNER_HEIGHT = 200;
export const MAX_ARTICLE_THUMBNAIL_BYTES = 8 * 1024 * 1024; // 8MB
export const MAX_ARTICLE_MEDIA_BYTES = 12 * 1024 * 1024; // 12MB
export const ARTICLE_THUMBNAIL_ASPECT_RATIO = 16 / 9; // 16:9
export const ARTICLE_THUMBNAIL_ASPECT_TOLERANCE = 0.05; // +/- 5%
export const MIN_ARTICLE_THUMBNAIL_WIDTH = 400;
// NOTE: we intentionally avoid "banner" in object paths because ad-blockers often block URLs containing it.
export const COVER_OBJECT_PREFIX = 'covers';

export function extForContentType(contentType: string) {
  if (contentType === 'image/jpeg') return 'jpg';
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  if (contentType === 'image/gif') return 'gif';
  if (contentType === 'video/mp4') return 'mp4';
  if (contentType === 'video/quicktime') return 'mov';
  if (contentType === 'video/webm') return 'webm';
  if (contentType === 'video/x-m4v') return 'm4v';
  if (contentType === 'audio/mp4' || contentType === 'audio/m4a' || contentType === 'audio/x-m4a') return 'm4a';
  if (contentType === 'audio/aac') return 'aac';
  if (contentType === 'audio/wav') return 'wav';
  return null;
}

export function isNotFoundLikeS3Error(err: unknown): boolean {
  // AWS SDK v3 errors vary by runtime; check common signals.
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
    $response?: { httpResponse?: { statusCode?: unknown } };
  };
  const code = String(e.name ?? e.Code ?? e.code ?? '').toLowerCase();
  const status = Number(e.$metadata?.httpStatusCode ?? e.$response?.httpResponse?.statusCode ?? NaN);
  return code.includes('notfound') || code.includes('nosuchkey') || status === 404;
}

export function isVideoContentType(contentType: string) {
  const ct = (contentType ?? '').trim().toLowerCase();
  return ct === 'video/mp4' || ct === 'video/quicktime' || ct === 'video/webm' || ct === 'video/x-m4v';
}

export function isAudioContentType(contentType: string) {
  return ALLOWED_AUDIO_CONTENT_TYPES.has((contentType ?? '').trim().toLowerCase());
}

export async function streamToBuffer(stream: any, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    // Node.js Readable supports async iteration.
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      total += buf.length;
      if (total > maxBytes) {
        // Best effort: stop the stream early.
        if (typeof stream?.destroy === 'function') stream.destroy();
        throw new BadRequestException('Uploaded file is too large.');
      }
    }
  } catch (e) {
    // Propagate known errors.
    throw e;
  }
  return Buffer.concat(chunks, total);
}
