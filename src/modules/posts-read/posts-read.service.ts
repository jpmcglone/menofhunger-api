import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { NOT_DELETED } from '../../common/prisma/where';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Storage queries for collaborating domains. Active rows are enforced here, even if a caller
 * forgets or overrides its deletion predicate. These rows are not viewer-authorized DTOs:
 * public surfaces must also apply their access policy or use PostVisibilityReadService.
 * Draft filtering belongs to the particular read surface, not to this storage boundary.
 */
@Injectable()
export class PostsReadService {
  constructor(private readonly prisma: PrismaService) {}

  findMany<T extends Prisma.PostFindManyArgs>(args: Prisma.SelectSubset<T, Prisma.PostFindManyArgs>) {
    const query = args as T;
    return this.prisma.post.findMany<T>({ ...query, where: { ...query.where, ...NOT_DELETED } } as Prisma.SelectSubset<T, Prisma.PostFindManyArgs>);
  }

  findFirst<T extends Prisma.PostFindFirstArgs>(args: Prisma.SelectSubset<T, Prisma.PostFindFirstArgs>) {
    const query = args as T;
    return this.prisma.post.findFirst<T>({ ...query, where: { ...query.where, ...NOT_DELETED } } as Prisma.SelectSubset<T, Prisma.PostFindFirstArgs>);
  }

  findUnique<T extends Prisma.PostFindUniqueArgs>(args: Prisma.SelectSubset<T, Prisma.PostFindUniqueArgs>) {
    const query = args as T;
    return this.prisma.post.findUnique<T>({ ...query, where: { ...query.where, ...NOT_DELETED } } as Prisma.SelectSubset<T, Prisma.PostFindUniqueArgs>);
  }

  count<T extends Prisma.PostCountArgs>(args: Prisma.SelectSubset<T, Prisma.PostCountArgs>) {
    const query = args as T;
    return this.prisma.post.count<T>({ ...query, where: { ...query.where, ...NOT_DELETED } } as Prisma.SelectSubset<T, Prisma.PostCountArgs>);
  }

  aggregate<T extends Prisma.PostAggregateArgs>(args: Prisma.Subset<T, Prisma.PostAggregateArgs>) {
    return this.prisma.post.aggregate<T>({ ...args, where: { ...(args.where as Prisma.PostWhereInput | undefined), ...NOT_DELETED } });
  }

  commentCountsByRoot(where: Prisma.PostWhereInput) {
    return this.prisma.post.groupBy({ by: ['rootId'], where: { ...where, ...NOT_DELETED }, _count: { _all: true } });
  }

  distinctAuthors(where: Prisma.PostWhereInput) {
    return this.prisma.post.groupBy({ by: ['userId'], where: { ...where, ...NOT_DELETED } });
  }

  lastActivityByGroup(where: Prisma.PostWhereInput) {
    return this.prisma.post.groupBy({ by: ['communityGroupId'], where: { ...where, ...NOT_DELETED }, _max: { createdAt: true } });
  }

  activityCountsByGroup(params: { where: Prisma.PostWhereInput; take: number }) {
    return this.prisma.post.groupBy({
      by: ['communityGroupId'], where: { ...params.where, ...NOT_DELETED },
      _count: { _all: true }, orderBy: { _count: { communityGroupId: 'desc' } }, take: params.take,
    });
  }

  /** Internal cursor/worker eligibility lookup: deleted records remain visible to the caller. */
  findIncludingDeleted<T extends Prisma.PostFindUniqueArgs>(args: Prisma.SelectSubset<T, Prisma.PostFindUniqueArgs>) {
    return this.prisma.post.findUnique<T>(args);
  }

  /** Tombstone hydration only. The owning viewer surface must still enforce access and hide body. */
  findManyIncludingDeleted<T extends Prisma.PostFindManyArgs>(args: Prisma.SelectSubset<T, Prisma.PostFindManyArgs>) {
    return this.prisma.post.findMany<T>(args);
  }
}
