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

  describe('media rendering', () => {
    it('names attached images, GIFs, and videos on the post line', () => {
      const svc = makeService();
      const threadContext: MarvThreadPost[] = [
        {
          id: 'p-1',
          authorUsername: 'bob',
          authorDisplayName: 'Bob',
          body: 'Shop day',
          createdAt: new Date().toISOString(),
          poll: null,
          media: [{ kind: 'image' }, { kind: 'gif' }, { kind: 'video' }],
        },
      ];
      const built = svc.build({ ...baseInput, threadContext });
      expect(built.developerNote).toContain('[attached: image + animated GIF + video]');
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

    it('marks a preview image when imageUrl is present', () => {
      const svc = makeService();
      const linkPreviews: MarvLinkPreview[] = [
        { url: 'https://example.com', title: 'Example', description: null, siteName: null, imageUrl: 'https://og.test/x.jpg' },
      ];
      const built = svc.build({ ...baseInput, linkPreviews });
      expect(built.developerNote).toContain('[preview image attached]');
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

    it('tells the model to look at attached images', () => {
      const svc = makeService();
      const built = svc.build({ ...baseInput, hasImagesAttached: true });
      expect(built.developerNote).toContain('look at them');
    });
  });

  describe('first-person identity instruction', () => {
    it('tells Marv to speak in the first person on thread replies', () => {
      const svc = makeService();
      const built = svc.build({ ...baseInput });
      expect(built.developerNote).toContain('first person');
      expect(built.developerNote).toContain('M.A.R.V.');
      expect(built.developerNote).toContain('You ARE Marv');
    });

    it('states the Reformed Baptist stance on every turn', () => {
      const svc = makeService();
      const built = svc.build({ ...baseInput });
      expect(built.developerNote).toContain('Reformed, Calvinist, and Baptist');
      expect(built.developerNote).toContain('not Presbyterian');
      expect(built.developerNote).toContain('Not neutral about truth');
    });

    it('maps first and last names onto @usernames and labels thread speakers', () => {
      const svc = makeService();
      const built = svc.build({
        ...baseInput,
        requester: { userId: 'u-1', username: 'jpmcglone', displayName: 'John McGlone' },
        threadContext: [
          {
            id: 'p-1',
            authorUsername: 'timk',
            authorDisplayName: 'Tim Kane',
            body: 'Ask Marv about John.',
            createdAt: new Date().toISOString(),
            poll: null,
          },
        ],
      });
      expect(built.developerNote).toContain('People in this conversation, nearest first');
      expect(built.developerNote).toContain('@jpmcglone (John McGlone)');
      expect(built.developerNote).toContain('@timk (Tim Kane)');
      expect(built.developerNote).toContain('find_members_by_name');
    });

    it('lists the nearest John before a distant John in the same thread', () => {
      const svc = makeService();
      const built = svc.build({
        ...baseInput,
        requester: { userId: 'u-alice', username: 'alice', displayName: 'Alice' },
        ancestors: [
          {
            id: 'p-root',
            authorUsername: 'johnroot',
            authorDisplayName: 'John Root',
            body: 'Starting the thread.',
            createdAt: new Date().toISOString(),
            poll: null,
          },
        ],
        triggeringPost: {
          id: 'p-ask',
          authorUsername: 'alice',
          authorDisplayName: 'Alice',
          body: 'What did John mean?',
          createdAt: new Date().toISOString(),
          poll: null,
        },
        descendants: [
          {
            id: 'p-reply',
            authorUsername: 'johnrecent',
            authorDisplayName: 'John Recent',
            body: 'I meant the fast.',
            createdAt: new Date().toISOString(),
            poll: null,
          },
        ],
      });
      const roster = built.developerNote.slice(
        built.developerNote.indexOf('People in this conversation, nearest first'),
      );
      expect(roster.indexOf('@johnrecent (John Recent)')).toBeGreaterThan(-1);
      expect(roster.indexOf('@johnrecent (John Recent)')).toBeLessThan(roster.indexOf('@johnroot (John Root)'));
      expect(roster).toContain('first match here');
    });

    it('tells Marv to speak in the first person on DM replies', () => {
      const svc = makeService();
      const built = svc.build({
        source: 'private_session',
        requester: { userId: 'u-1', username: 'alice', displayName: 'Alice' },
        currentQuestion: 'hey',
        conversationId: 'c-1',
      });
      expect(built.developerNote).toContain('first person');
    });
  });

  describe('community group context rendering', () => {
    it('includes the group name and description when the thread is in a group', () => {
      const svc = makeService();
      const built = svc.build({
        ...baseInput,
        group: { name: 'Morning Fasters', description: 'Men who fast together before sunrise.' },
      });
      expect(built.developerNote).toContain('community group "Morning Fasters"');
      expect(built.developerNote).toContain('Men who fast together before sunrise.');
      expect(built.developerNote).toContain('respond primarily to what is in the thread');
    });

    it('includes group rules and membership when provided', () => {
      const svc = makeService();
      const built = svc.build({
        ...baseInput,
        group: {
          name: 'Morning Fasters',
          description: 'Men who fast together before sunrise.',
          rules: 'No selling. Be kind.',
          joinPolicy: 'approval',
          memberCount: 42,
        },
      });
      expect(built.developerNote).toContain('Group rules: "No selling. Be kind."');
      expect(built.developerNote).toContain('approval required to join');
      expect(built.developerNote).toContain('42 members');
    });

    it('omits the description line when the group has no description', () => {
      const svc = makeService();
      const built = svc.build({
        ...baseInput,
        group: { name: 'Quiet Group', description: null },
      });
      expect(built.developerNote).toContain('community group "Quiet Group"');
      expect(built.developerNote).not.toContain('Group description:');
    });

    it('does not mention any group when none is provided', () => {
      const svc = makeService();
      const built = svc.build({ ...baseInput });
      expect(built.developerNote).not.toContain('community group');
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

  describe('bidirectional context rendering', () => {
    const ancestor: MarvThreadPost = {
      id: 'a-1',
      authorUsername: 'rootguy',
      authorDisplayName: 'Root Guy',
      body: 'The original post.',
      createdAt: new Date().toISOString(),
      poll: null,
    };
    const trigger: MarvThreadPost = {
      id: 'p-1',
      authorUsername: 'alice',
      authorDisplayName: 'Alice',
      body: 'hey @marv what about this',
      createdAt: new Date().toISOString(),
      poll: null,
    };
    const descendant: MarvThreadPost = {
      id: 'd-1',
      authorUsername: 'bob',
      authorDisplayName: 'Bob',
      body: 'a reply that came after.',
      createdAt: new Date().toISOString(),
      poll: null,
    };

    it('renders the path above, the mention, and replies below as sections', () => {
      const svc = makeService();
      const built = svc.build({
        ...baseInput,
        ancestors: [ancestor],
        triggeringPost: trigger,
        descendants: [descendant],
      });
      expect(built.developerNote).toContain('Path above the message that mentions you');
      expect(built.developerNote).toContain('The message that mentions you:');
      expect(built.developerNote).toContain('Replies under it');
      expect(built.developerNote).toContain('The original post.');
      expect(built.developerNote).toContain('a reply that came after.');
      // The triggering post is tagged.
      expect(built.developerNote).toContain('[← this message mentions you]');
    });

    it('includes the rolling summary when provided', () => {
      const svc = makeService();
      const built = svc.build({
        ...baseInput,
        triggeringPost: trigger,
        rollingSummary: 'Earlier, the group debated fasting cadence.',
      });
      expect(built.developerNote).toContain('Thread summary so far');
      expect(built.developerNote).toContain('Earlier, the group debated fasting cadence.');
    });

    it('prefers bidirectional fields over legacy threadContext', () => {
      const svc = makeService();
      const built = svc.build({
        ...baseInput,
        triggeringPost: trigger,
        threadContext: [ancestor],
      });
      // The sectioned header is used, not the flat "Thread (oldest → newest)" header.
      expect(built.developerNote).toContain('The message that mentions you:');
      expect(built.developerNote).not.toContain('Thread (oldest → newest)');
    });
  });

  describe('member lookup hints', () => {
    it('injects prefetched member cards and forbids session-limitation language', () => {
      const svc = makeService();
      const built = svc.build({
        source: 'private_session',
        requester: { userId: 'u-1', username: 'alice', displayName: 'Alice' },
        currentQuestion: 'what do you know about @peter and @lamarm',
        conversationId: 'c-1',
        referencedMemberCards: [
          { username: 'peter', cardText: 'Peter tracks morning weight and gym logs.' },
          { username: 'lamarm', cardText: '@lamarm is a member, 3 months on the platform.' },
        ],
      });
      expect(built.developerNote).toContain('Peter tracks morning weight');
      expect(built.developerNote).toContain('@lamarm is a member');
      expect(built.developerNote).toContain('Background on members who appear here');
      expect(built.developerNote).toContain('Do not name them unless the question requires it');
      expect(built.developerNote).toContain('get_user_context_card');
    });

    it('marks unknown mentioned usernames as not found', () => {
      const svc = makeService();
      const built = svc.build({
        ...baseInput,
        referencedMemberCards: [{ username: 'nobody', cardText: null }],
      });
      expect(built.developerNote).toContain('@nobody: no member found with that username.');
    });

    it('tells Marv to look up mentioned members when cards were not prefetched', () => {
      const svc = makeService();
      const built = svc.build({
        source: 'private_session',
        requester: { userId: 'u-1', username: 'alice', displayName: 'Alice' },
        currentQuestion: 'hey',
        conversationId: 'c-1',
        referencedUsernames: ['peter', 'lamarm'],
      });
      expect(built.developerNote).toContain('Members mentioned: @peter, @lamarm');
      expect(built.developerNote).toContain('these tools work for any member');
    });
  });
});
