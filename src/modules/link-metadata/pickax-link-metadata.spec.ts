import { describe, expect, it } from '@jest/globals';
import {
  isPickaxPostUrl,
  isWeakPickaxImage,
  needsPickaxEnrichment,
  parsePickaxAuthorFromJina,
  parsePickaxBodyFromJina,
  pickaxAuthorFromTitle,
} from './pickax-link-metadata';

describe('Pickax link metadata parsers', () => {
  it('detects pickax post URLs', () => {
    expect(isPickaxPostUrl('https://pickax.com/post/442202')).toBe(true);
    expect(isPickaxPostUrl('https://www.pickax.com/post/1')).toBe(true);
    expect(isPickaxPostUrl('https://pickax.com/FeralHousewife')).toBe(false);
    expect(isPickaxPostUrl('https://menofhunger.com/p/1')).toBe(false);
  });

  it('treats favicon as a weak image', () => {
    expect(isWeakPickaxImage('https://pickax.com/favicon.png')).toBe(true);
    expect(
      isWeakPickaxImage(
        'https://img.pickax.com/user-51607/8ed78355-637f-4212-8216-69ec517f36bb.jpeg',
      ),
    ).toBe(false);
  });

  it('only re-enriches incomplete Pickax OG rows', () => {
    expect(
      needsPickaxEnrichment({
        title: 'Feral Housewife posted',
        imageUrl: 'https://pickax.com/favicon.png',
        siteName: 'Pickax',
      }),
    ).toBe(true);
    expect(
      needsPickaxEnrichment({
        title: 'Feral Housewife',
        description: 'Full post body.',
        imageUrl: 'https://img.pickax.com/user-51607/avatar.jpeg',
        siteName: '@FeralHousewife',
      }),
    ).toBe(false);
    // Older enrichment recovered identity but omitted content; retry those rows.
    expect(
      needsPickaxEnrichment({
        title: 'Feral Housewife',
        description: null,
        imageUrl: null,
        siteName: '@FeralHousewife',
      }),
    ).toBe(true);
    // Cached reader snapshots can provide full body/name while omitting avatar chrome.
    expect(
      needsPickaxEnrichment({
        title: 'Jeff Dornik',
        description: 'The complete post body.',
        imageUrl: null,
        siteName: 'Pickax',
      }),
    ).toBe(false);
    // Microlink publisher host still counts as incomplete.
    expect(
      needsPickaxEnrichment({
        title: 'Feral Housewife posted',
        imageUrl: 'https://pickax.com/favicon.png',
        siteName: 'pickax.com',
      }),
    ).toBe(true);
  });

  it('parses author name from Pickax OG titles', () => {
    expect(pickaxAuthorFromTitle('Feral Housewife posted')).toBe('Feral Housewife');
    expect(pickaxAuthorFromTitle('Steve Jobs posted.')).toBe('Steve Jobs');
  });

  it('parses avatar + username from Jina markdown', () => {
    const md = `
Title: Feral Housewife posted

[![Image 1](https://img.pickax.com/user-51607/8ed78355-637f-4212-8216-69ec517f36bb.jpeg)](https://pickax.com/FeralHousewife)

are yall watching this?
`;
    expect(parsePickaxAuthorFromJina(md)).toEqual({
      avatarUrl: 'https://img.pickax.com/user-51607/8ed78355-637f-4212-8216-69ec517f36bb.jpeg',
      username: 'FeralHousewife',
    });
  });

  it('parses full post body between author avatar and next image', () => {
    const md = `Title: Feral Housewife posted

URL Source: https://pickax.com/post/442202

Markdown Content:
[![Image 1](https://img.pickax.com/user-51607/8ed78355-637f-4212-8216-69ec517f36bb.jpeg)](https://pickax.com/FeralHousewife)

are yall watching this? that Joker guy is soooooooo trained to be argumentative that he cannot stop fighting and arguing. He seriously thinks that being positive is terrible? wtf?

am i terrible? do yall just give sympathy likes?

[![Image 2](https://img.pickax.com/user-7/3b622ec2-3231-404a-8eb2-804631d4425a.png)](https://pickax.com/Pickax)

18 hours ago
`;
    expect(parsePickaxBodyFromJina(md)).toBe(
      [
        'are yall watching this? that Joker guy is soooooooo trained to be argumentative that he cannot stop fighting and arguing. He seriously thinks that being positive is terrible? wtf?',
        '',
        'am i terrible? do yall just give sympathy likes?',
      ].join('\n'),
    );
  });

  it('parses body-only cached snapshots and cleans Pickax mention links', () => {
    const md = `Title: Jeff Dornik posted

URL Source: https://pickax.com/post/441980

Warning: This is a cached snapshot of the original page.

Markdown Content:
If the allegations are credible, the timing deserves scrutiny.

\u00ad

I said during my interview with [@KristiLeighTV](https://pickax.com/KristiLeighTV) that voters deserve answers.
`;
    expect(parsePickaxBodyFromJina(md)).toBe(
      [
        'If the allegations are credible, the timing deserves scrutiny.',
        '',
        'I said during my interview with @KristiLeighTV that voters deserve answers.',
      ].join('\n'),
    );
  });
});
