import { readFileSync } from 'fs';
import { resolve } from 'path';

function readFromRepo(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('PostsController media feed guardrails', () => {
  it('routes For You media through For You instead of chronological media fallback', () => {
    const src = readFromRepo('src/modules/posts/posts.controller.ts');
    expect(src).toContain("const mediaChronological = mediaOnly && !groupScoped && sortKind !== 'forYou' && sortKind !== 'popular';");
  });

  it('fills sparse For You media pages with chronological media fallback rows', () => {
    const src = readFromRepo('src/modules/posts/posts-feed-query.service.ts');
    expect(src).toContain('const fetchChronologicalMediaFallback = async');
    expect(src).toContain('if (!params.mediaOnly || take <= 0) return { posts: [], overflow: false };');
  });

  it('fills sparse trending feeds from the chronological zero-score tail', () => {
    const src = readFromRepo('src/modules/posts/posts-feed-query.service.ts');
    expect(src).toContain("const chronologicalScoreWhere: Prisma.PostWhereInput = {");
    expect(src).toContain("OR: [{ trendingScore: 0 }, { trendingScore: null }]");
    expect(src).toContain("return toResult([...trendingPosts, ...fallbackSlice], hasMoreFallback);");
  });

  it('caches authed For You first page with a stampede lock', () => {
    const src = readFromRepo('src/modules/posts/posts.controller.ts');
    expect(src).toContain('authForYouFirstPageCache');
    expect(src).toContain('getOrSetJsonWithLock');
    expect(src).toContain('authPostsListLock');
    expect(src).toContain("? 'auth_foryou'");
    expect(src).toContain('forYouUserVer');
  });
});
