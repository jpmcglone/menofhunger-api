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
    const src = readFromRepo('src/modules/posts/posts.service.ts');
    expect(src).toContain('const fetchChronologicalMediaFallback = async');
    expect(src).toContain('if (!params.mediaOnly || take <= 0) return { posts: [], overflow: false };');
  });

  it('lets media trending include zero-score media instead of going empty', () => {
    const src = readFromRepo('src/modules/posts/posts.service.ts');
    expect(src).toContain("? { OR: [{ trendingScore: { gte: 0 } }, { trendingScore: null }] }");
  });
});
