import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readFromRepo(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('perf guardrails (structural)', () => {
  it('API code avoids include: { user: true } on service queries (explicit selects)', () => {
    const files = [
      'src/modules/posts/posts.service.ts',
      'src/modules/search/search.service.ts',
      'src/modules/topics/topics.service.ts',
      'src/modules/auth/auth.service.ts',
      'src/modules/verification/verification.service.ts',
      'src/modules/admin/admin-image-review.service.ts',
    ];
    for (const f of files) {
      const src = readFromRepo(f);
      expect(src).not.toMatch(/user:\s*true/);
    }
  });
});

