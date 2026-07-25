import { describe, expect, it } from '@jest/globals';
import {
  isXPostUrl,
  parseXSyndicationResponse,
  parseXPostUrl,
  xSyndicationToken,
} from './x-link-metadata';

describe('X link metadata', () => {
  it('recognizes x.com and twitter.com status URLs only', () => {
    expect(parseXPostUrl('https://x.com/jack/status/20?s=20')).toEqual({
      id: '20',
      handle: 'jack',
      canonicalUrl: 'https://x.com/jack/status/20',
    });
    expect(isXPostUrl('https://twitter.com/jack/status/20/photo/1')).toBe(true);
    expect(isXPostUrl('https://x.com/jack')).toBe(false);
    expect(isXPostUrl('https://example.com/jack/status/20')).toBe(false);
    expect(xSyndicationToken('20')).toBe('6dq1a2xwd93');
  });

  it('maps rich X syndication data including media and a quote', () => {
    const parsed = parseXSyndicationResponse(
      {
        __typename: 'Tweet',
        id_str: '200',
        text: 'Jesus was a Jew. Facts remain.',
        created_at: '2026-07-14T12:00:00.000Z',
        user: {
          name: 'Isabelle',
          screen_name: 'TheIsabelleHQ',
          profile_image_url_https: 'https://pbs.twimg.com/profile_images/isabelle.jpg',
          is_blue_verified: true,
        },
        conversation_count: 9,
        retweet_count: 3,
        favorite_count: 11,
        views: { count: '1200' },
        photos: [
          {
            url: 'https://pbs.twimg.com/media/photo.jpg',
            width: 1200,
            height: 800,
            alt_text: 'Photo description',
          },
        ],
        quoted_tweet: {
          __typename: 'Tweet',
          id_str: '100',
          text: 'With regard to "Judeo Christian":',
          created_at: '2026-07-14T10:00:00.000Z',
          user: {
            name: 'Dr Jordan B Peterson',
            screen_name: 'jordanbpeterson',
            profile_image_url_https: 'https://pbs.twimg.com/profile_images/jordan.jpg',
            verified: true,
          },
          video: {
            poster: 'https://pbs.twimg.com/video_thumb.jpg',
            width: 1280,
            height: 720,
            variants: [
              {
                type: 'video/mp4',
                src: 'https://video.twimg.com/video.mp4',
                bitrate: 2_000_000,
              },
            ],
          },
        },
      },
      'https://x.com/isabelle/status/200',
    );

    expect(parsed).toMatchObject({
      platform: 'x',
      id: '200',
      text: 'Jesus was a Jew. Facts remain.',
      author: {
        name: 'Isabelle',
        handle: '@TheIsabelleHQ',
        verified: true,
      },
      metrics: { replies: 9, reposts: 3, likes: 11, views: 1200 },
      media: [
        {
          type: 'image',
          url: 'https://pbs.twimg.com/media/photo.jpg',
          alt: 'Photo description',
        },
      ],
      quote: {
        id: '100',
        text: 'With regard to "Judeo Christian":',
        author: {
          name: 'Dr Jordan B Peterson',
          handle: '@jordanbpeterson',
          verified: true,
        },
      },
    });
    expect(parsed?.quote?.media[0]).toMatchObject({
      type: 'video',
      url: 'https://video.twimg.com/video.mp4',
      previewUrl: 'https://pbs.twimg.com/video_thumb.jpg',
    });
  });

  it('rejects malformed or failed API responses', () => {
    expect(
      parseXSyndicationResponse(
        { __typename: 'TweetTombstone' },
        'https://x.com/jack/status/20',
      ),
    ).toBeNull();
    expect(
      parseXSyndicationResponse(
        { __typename: 'Tweet', id_str: '20', text: 'Missing author' },
        'https://x.com/jack/status/20',
      ),
    ).toBeNull();
  });
});
