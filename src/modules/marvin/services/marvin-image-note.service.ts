import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../app/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SideEffectsService } from '../../side-effects/side-effects.service';
import { resolveMarvVisionUrl } from './marvin-vision-media';
import { NOT_DELETED } from '../../../common/prisma/where';

/** A caption this long is already searchable text; the note only helps photos with little or no writing. */
export const IMAGE_NOTE_MAX_BODY_CHARS = 24;
export const IMAGE_NOTE_MAX_CHARS = 200;
const IMAGE_NOTE_MIN_CHARS = 3;

export type MarvImageNoteCandidate = {
  /** File the note describes (the image, or a video's poster). */
  r2Key: string;
  postId: string;
  /** URL Marv was shown, so a candidate is only offered for an image he is actually looking at. */
  imageUrl: string;
};

/**
 * Lets Marv save one short literal note for a photo he is already looking at on a paid vision turn.
 * Never triggers a vision call. Notes feed post search (keyword, Jev topics, first embedding).
 */
@Injectable()
export class MarvinImageNoteService {
  private readonly logger = new Logger(MarvinImageNoteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly sideEffects: SideEffectsService,
  ) {}

  /**
   * Upload images and video posters of a thin, readable post that have no note yet.
   * GIFs, link previews, and message attachments never qualify.
   */
  private async eligibleMedia(postId: string): Promise<Array<{ r2Key: string; imageUrl: string }>> {
    const id = (postId ?? '').trim();
    if (!id) return [];
    // Read through the media relation so the posts table stays owned by the posts module.
    const rows = await this.prisma.postMedia.findMany({
      where: {
        postId: id,
        ...NOT_DELETED,
        source: 'upload',
        kind: { in: ['image', 'video'] },
        post: { ...NOT_DELETED, isDraft: false, kind: { not: 'repost' }, visibility: { not: 'onlyMe' } },
      },
      select: {
        kind: true,
        source: true,
        r2Key: true,
        url: true,
        thumbnailR2Key: true,
        post: { select: { body: true, hashtags: true } },
      },
      orderBy: { position: 'asc' },
      take: 8,
    });
    const post = rows[0]?.post;
    if (!post) return [];
    if ((post.body ?? '').trim().length >= IMAGE_NOTE_MAX_BODY_CHARS || (post.hashtags ?? []).length > 0) return [];

    const baseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const out: Array<{ r2Key: string; imageUrl: string }> = [];
    for (const media of rows) {
      const r2Key = media.kind === 'video' ? media.thumbnailR2Key : media.r2Key;
      const imageUrl = resolveMarvVisionUrl(media, baseUrl);
      if (r2Key && imageUrl) out.push({ r2Key, imageUrl });
    }
    return out;
  }

  /** The one image on this post that Marv is viewing and nobody has described yet, or null. */
  async candidateForPost(postId: string, attachedImageUrls: readonly string[]): Promise<MarvImageNoteCandidate | null> {
    if (attachedImageUrls.length === 0) return null;
    const attached = new Set(attachedImageUrls);
    const viewing = (await this.eligibleMedia(postId)).filter((m) => attached.has(m.imageUrl));
    if (viewing.length === 0) return null;
    const existing = await this.prisma.mediaSearchNote.findMany({
      where: { r2Key: { in: viewing.map((m) => m.r2Key) } },
      select: { r2Key: true },
    });
    const noted = new Set(existing.map((n) => n.r2Key));
    const pick = viewing.find((m) => !noted.has(m.r2Key));
    return pick ? { r2Key: pick.r2Key, imageUrl: pick.imageUrl, postId } : null;
  }

  /** Cleans model text into a short literal note, or null when it is unusable. */
  static sanitize(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const note = raw
      .replace(/https?:\/\/\S+/gi, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, IMAGE_NOTE_MAX_CHARS)
      .trim();
    return note.length >= IMAGE_NOTE_MIN_CHARS ? note : null;
  }

  /** Writes the note only when the file is still undescribed and the post is still eligible. */
  async record(candidate: MarvImageNoteCandidate, rawNote: unknown): Promise<boolean> {
    const note = MarvinImageNoteService.sanitize(rawNote);
    if (!note) return false;
    const stillEligible = (await this.eligibleMedia(candidate.postId)).some((m) => m.r2Key === candidate.r2Key);
    if (!stillEligible) return false;
    const created = await this.prisma.mediaSearchNote.createMany({
      data: [{ r2Key: candidate.r2Key, note, postId: candidate.postId }],
      skipDuplicates: true,
    });
    if (created.count === 0) return false;
    this.logger.log(`[marv-image-note] saved note for post=${candidate.postId}`);
    this.sideEffects.dispatch('media.searchNote.recorded', { postId: candidate.postId, r2Key: candidate.r2Key });
    return true;
  }
}
