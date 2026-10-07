import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Read-only view of the post table. Writes belong to the posts module. */
export type PostReadDelegate = Pick<
  Prisma.PostDelegate,
  'findMany' | 'findFirst' | 'findUnique' | 'findUniqueOrThrow' | 'findFirstOrThrow' | 'count' | 'groupBy' | 'aggregate'
>;

/**
 * The only way for modules outside `posts/` to read posts. Keeping reads behind one seam lets
 * the posts module own soft-delete, visibility, and query-shape policy without every caller
 * reaching into Prisma directly.
 */
@Injectable()
export class PostsReadService {
  constructor(private readonly prisma: PrismaService) {}

  get read(): PostReadDelegate {
    return this.prisma.post;
  }
}
