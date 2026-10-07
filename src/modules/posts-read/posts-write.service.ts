import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Field-level post writes for modules outside `posts/` (crosspost status, counters, pins,
 * mirrored board/article/fitness rows). Deletes and upserts stay inside the posts module.
 */
export type PostWriteDelegate = Pick<Prisma.PostDelegate, 'create' | 'update' | 'updateMany'>;

/**
 * The only way for modules outside `posts/` to write post rows. Lives beside
 * `PostsReadService` in the global posts-read module so callers never import `PostsModule`
 * (which would create cycles) yet every external write is greppable in one place.
 */
@Injectable()
export class PostsWriteService {
  constructor(private readonly prisma: PrismaService) {}

  get write(): PostWriteDelegate {
    return this.prisma.post;
  }

  /** Same delegate on a transaction client so pin/counter writes stay atomic. */
  writeOn(client: { post: PostWriteDelegate }): PostWriteDelegate {
    return client.post;
  }
}
