import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import {
  isSubstackPostUrl,
  parseSubstackPostParts,
  enrichSubstackPost,
} from './substack-link-metadata';

describe('isSubstackPostUrl', () => {
  it('matches standard post URLs', () => {
    expect(isSubstackPostUrl('https://joelwebbon.substack.com/p/the-men-of-yesterday')).toBe(true);
    expect(isSubstackPostUrl('https://newsletter.substack.com/p/issue-42')).toBe(true);
    expect(isSubstackPostUrl('https://joelwebbon.substack.com/p/some-post/comments')).toBe(true);
  });

  it('rejects non-post Substack URLs', () => {
    expect(isSubstackPostUrl('https://joelwebbon.substack.com')).toBe(false);
    expect(isSubstackPostUrl('https://joelwebbon.substack.com/archive')).toBe(false);
    expect(isSubstackPostUrl('https://substack.com/p/some-post')).toBe(false); // root domain
  });

  it('rejects non-Substack URLs', () => {
    expect(isSubstackPostUrl('https://menofhunger.com/p/some-post')).toBe(false);
    expect(isSubstackPostUrl('https://pickax.com/post/442202')).toBe(false);
    expect(isSubstackPostUrl('not-a-url')).toBe(false);
  });
});

describe('parseSubstackPostParts', () => {
  it('extracts subdomain and slug', () => {
    expect(parseSubstackPostParts('https://joelwebbon.substack.com/p/the-men-of-yesterday')).toEqual(
      { subdomain: 'joelwebbon', slug: 'the-men-of-yesterday' },
    );
  });

  it('extracts slug even when /comments suffix is present', () => {
    expect(parseSubstackPostParts('https://joelwebbon.substack.com/p/some-post/comments')).toEqual(
      { subdomain: 'joelwebbon', slug: 'some-post' },
    );
  });

  it('returns null for root domain', () => {
    expect(parseSubstackPostParts('https://substack.com/p/some-post')).toBeNull();
  });
});

describe('enrichSubstackPost', () => {
  const controller = new AbortController();

  beforeEach(() => {
    jest.spyOn(global, 'fetch').mockImplementation(async (_input) => {
      const json: Record<string, unknown> = {
        title: 'The Men of Yesterday and the Boys of Today',
        subtitle: 'A reflection on what we have lost.',
        cover_image: 'https://substackcdn.com/image/fetch/cover.jpg',
        publication: {
          name: 'Joel Webbon',
          subdomain: 'joelwebbon',
        },
      };
      return {
        ok: true,
        status: 200,
        json: async () => json,
      } as Response;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('maps API response to flat LinkMetadataDto fields', async () => {
    const result = await enrichSubstackPost(
      'https://joelwebbon.substack.com/p/the-men-of-yesterday',
      controller.signal,
    );
    expect(result).toEqual({
      title: 'The Men of Yesterday and the Boys of Today',
      description: 'A reflection on what we have lost.',
      imageUrl: 'https://substackcdn.com/image/fetch/cover.jpg',
      siteName: 'Joel Webbon',
    });
  });

  it('returns null when title is missing', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ subtitle: 'No title here' }),
    }) as Response);
    const result = await enrichSubstackPost(
      'https://joelwebbon.substack.com/p/some-post',
      controller.signal,
    );
    expect(result).toBeNull();
  });

  it('returns null when API returns 404', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }) as Response);
    const result = await enrichSubstackPost(
      'https://joelwebbon.substack.com/p/nonexistent',
      controller.signal,
    );
    expect(result).toBeNull();
  });

  it('formats subdomain as siteName fallback when publication.name is absent', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ title: 'Some Post', subtitle: 'A subtitle.' }),
    }) as Response);
    const result = await enrichSubstackPost(
      'https://joel-webbon.substack.com/p/some-post',
      controller.signal,
    );
    expect(result?.siteName).toBe('Joel Webbon');
  });
});
