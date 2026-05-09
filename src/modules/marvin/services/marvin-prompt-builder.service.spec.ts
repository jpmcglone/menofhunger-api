import { MarvinPromptBuilderService } from './marvin-prompt-builder.service';
import type { MarvThreadPost, MarvLinkPreview } from './marvin-prompt-builder.service';

function makeService(): MarvinPromptBuilderService {
  return new MarvinPromptBuilderService();
}

const baseInput = {
  source: 'public_thread' as const,
  requester: { userId: 'u-1', username: 'alice', displayName: 'Alice' },
  currentQuestion: 'What do you think?',
  triggeringPostId: 'p-1',
  rootPostId: 'r-1',
};

describe('MarvinPromptBuilderService', () => {
  describe('poll rendering', () => {
    it('includes poll text after post body in thread context', () => {
      const svc = makeService();
      const threadContext: MarvThreadPost[] = [
        {
          id: 'p-root',
          authorUsername: 'bob',
          authorDisplayName: 'Bob',
          body: 'Should we fast together?',
          createdAt: new Date().toISOString(),
          poll: {
            totalVoteCount: 10,
            endsAt: null,
            options: [
              { text: 'Yes', voteCount: 7 },
              { text: 'No', voteCount: 3 },
            ],
          },
        },
      ];
      const built = svc.build({ ...baseInput, threadContext });
      expect(built.developerNote).toContain('[Poll on this post]');
      expect(built.developerNote).toContain('"Yes"');
      expect(built.developerNote).toContain('"No"');
      expect(built.developerNote).toContain('10 vote');
    });

    it('includes vote percentages', () => {
      const svc = makeService();
      const threadContext: MarvThreadPost[] = [
        {
          id: 'p-root',
          authorUsername: 'bob',
          authorDisplayName: 'Bob',
          body: 'Vote!',
          createdAt: new Date().toISOString(),
          poll: {
            totalVoteCount: 4,
            endsAt: null,
            options: [
              { text: 'A', voteCount: 3 },
              { text: 'B', voteCount: 1 },
            ],
          },
        },
      ];
      const built = svc.build({ ...baseInput, threadContext });
      expect(built.developerNote).toContain('75%');
      expect(built.developerNote).toContain('25%');
    });

    it('handles zero totalVoteCount gracefully', () => {
      const svc = makeService();
      const threadContext: MarvThreadPost[] = [
        {
          id: 'p-root',
          authorUsername: 'bob',
          authorDisplayName: 'Bob',
          body: 'New poll',
          createdAt: new Date().toISOString(),
          poll: {
            totalVoteCount: 0,
            endsAt: null,
            options: [{ text: 'Yes', voteCount: 0 }],
          },
        },
      ];
      expect(() => svc.build({ ...baseInput, threadContext })).not.toThrow();
      const built = svc.build({ ...baseInput, threadContext });
      expect(built.developerNote).toContain('0 vote');
    });

    it('includes poll close date when endsAt is set', () => {
      const svc = makeService();
      const endsAt = new Date('2025-12-31T18:00:00Z');
      const threadContext: MarvThreadPost[] = [
        {
          id: 'p-1',
          authorUsername: 'carol',
          authorDisplayName: 'Carol',
          body: 'Poll',
          createdAt: new Date().toISOString(),
          poll: { totalVoteCount: 2, endsAt, options: [{ text: 'X', voteCount: 2 }] },
        },
      ];
      const built = svc.build({ ...baseInput, threadContext });
      expect(built.developerNote).toContain('2025');
    });

    it('does not emit poll block when poll is null', () => {
      const svc = makeService();
      const threadContext: MarvThreadPost[] = [
        {
          id: 'p-1',
          authorUsername: 'bob',
          authorDisplayName: 'Bob',
          body: 'No poll here',
          createdAt: new Date().toISOString(),
          poll: null,
        },
      ];
      const built = svc.build({ ...baseInput, threadContext });
      expect(built.developerNote).not.toContain('[Poll on this post]');
    });
  });

  describe('link preview rendering', () => {
    it('renders link previews at the end of the developer note', () => {
      const svc = makeService();
      const linkPreviews: MarvLinkPreview[] = [
        { url: 'https://example.com', title: 'Example Site', description: 'A great site.', siteName: 'Example' },
      ];
      const built = svc.build({ ...baseInput, linkPreviews });
      expect(built.developerNote).toContain('[Link previews');
      expect(built.developerNote).toContain('"Example Site"');
      expect(built.developerNote).toContain('Example');
      expect(built.developerNote).toContain('A great site.');
    });

    it('falls back to url as title when title is missing', () => {
      const svc = makeService();
      const linkPreviews: MarvLinkPreview[] = [
        { url: 'https://example.com/no-title', title: null, description: null, siteName: null },
      ];
      const built = svc.build({ ...baseInput, linkPreviews });
      expect(built.developerNote).toContain('https://example.com/no-title');
    });

    it('skips link preview block when array is empty', () => {
      const svc = makeService();
      const built = svc.build({ ...baseInput, linkPreviews: [] });
      expect(built.developerNote).not.toContain('[Link previews');
    });

    it('skips link preview block when not provided', () => {
      const svc = makeService();
      const built = svc.build({ ...baseInput });
      expect(built.developerNote).not.toContain('[Link previews');
    });
  });

  describe('GIF note rendering', () => {
    it('injects GIF still-frame note when hasGifAttached is true', () => {
      const svc = makeService();
      const built = svc.build({ ...baseInput, hasGifAttached: true });
      expect(built.developerNote).toContain('single still frame');
    });

    it('does not inject GIF note when hasGifAttached is false', () => {
      const svc = makeService();
      const built = svc.build({ ...baseInput, hasGifAttached: false });
      expect(built.developerNote).not.toContain('single still frame');
    });
  });

  describe('userMessage passthrough', () => {
    it('trims and slices currentQuestion to 4000 chars', () => {
      const svc = makeService();
      const long = 'x'.repeat(5000);
      const built = svc.build({ ...baseInput, currentQuestion: '  ' + long + '  ' });
      expect(built.userMessage.length).toBe(4000);
    });
  });
});
