import { classify, ContentScreenService } from './content-screen.service';

import { PostsReadService } from '../posts-read/posts-read.service';
const moderationsCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ moderations: { create: moderationsCreate } })),
}));

const NOW = Date.now();
function make(post: any, postCount = 50, enabled = true) {
  const prisma: any = {
    post: { findFirst: jest.fn(async () => post), count: jest.fn(async () => postCount) },
    report: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
  };
  const config: any = { contentScreen: () => ({ enabled, apiKey: 'k' }) };
  return { svc: new ContentScreenService(config, prisma, new PostsReadService(prisma as never)), prisma };
}
const post = (over: any = {}) => ({
  id: 'p1', userId: 'u1', body: 'a perfectly ordinary post body',
  user: { createdAt: new Date(NOW - 400 * 86_400_000), isBot: false }, ...over,
});

describe('ContentScreenService', () => {
  beforeEach(() => moderationsCreate.mockReset());

  it('does not spend a call on an established author with no link', async () => {
    const { svc } = make(post());
    expect(await svc.screenPost('p1', 'marv')).toBe('skipped');
    expect(moderationsCreate).not.toHaveBeenCalled();
  });

  it('screens a new account and files a pending report on a hit', async () => {
    moderationsCreate.mockResolvedValue({ results: [{ category_scores: { harassment: 0.95 } }] });
    const { svc, prisma } = make(post({ user: { createdAt: new Date(NOW - 86_400_000), isBot: false } }));
    expect(await svc.screenPost('p1', 'marv')).toBe('flagged');
    expect(prisma.report.create).toHaveBeenCalledTimes(1);
    expect(prisma.report.create.mock.calls[0][0].data.reason).toBe('harassment');
  });

  it('screens a post with a link and stays quiet when clean', async () => {
    moderationsCreate.mockResolvedValue({ results: [{ category_scores: { harassment: 0.01 } }] });
    const { svc, prisma } = make(post({ body: 'read this https://example.com/article' }));
    expect(await svc.screenPost('p1', 'marv')).toBe('clean');
    expect(prisma.report.create).not.toHaveBeenCalled();
  });

  it('never files a second report for the same post', async () => {
    moderationsCreate.mockResolvedValue({ results: [{ category_scores: { hate: 0.9 } }] });
    const { svc, prisma } = make(post({ body: 'see https://x.test' }));
    prisma.report.findFirst.mockResolvedValue({ id: 'r' });
    expect(await svc.screenPost('p1', 'marv')).toBe('flagged');
    expect(prisma.report.create).not.toHaveBeenCalled();
  });

  it('is fail-soft and respects the switch', async () => {
    moderationsCreate.mockRejectedValue(new Error('down'));
    expect(await make(post({ body: 'see https://x.test' })).svc.screenPost('p1', 'marv')).toBe('failed');
    expect(await make(post(), 0, false).svc.screenPost('p1', 'marv')).toBe('skipped');
  });
});

describe('classify', () => {
  it('uses a lower bar for self-harm and ignores weak scores', () => {
    expect(classify({ 'self-harm': 0.55 })?.reason).toBe('other');
    expect(classify({ harassment: 0.5, sexual: 0.4 })).toBeNull();
    expect(classify({ violence: 0.9, hate: 0.8 })?.reason).toBe('violence');
  });
});
