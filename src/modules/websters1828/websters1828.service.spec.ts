/**
 * Fixture-based tests for Websters1828Service.fetchWordOfDay().
 *
 * We mock global.fetch so no real HTTP requests are made.
 * Tests assert:
 *   1. The depth-counting block scan stops at the correct closing </div> and does not
 *      over-capture into trailing ad or mobile markup.
 *   2. "First Occurrence in the Bible" and everything after it is stripped.
 *   3. The dictionary-page definition is preferred over the homepage block definition.
 *   4. The word is correctly extracted from the <h3> tag.
 */

import { Websters1828Service } from './websters1828.service';

// ─── Fixture helpers ─────────────────────────────────────────────────────────

/** Minimal homepage HTML with an "Oration" WOTD block followed by ad content. */
const homepageHtml = `
<!DOCTYPE html>
<html>
<body>
  <div id="WordOfTheDay">
    <h3>Oration</h3>
    <p>An elaborate discourse delivered in public.</p>
    <p>First Occurrence in the Bible(KJV): Acts 12:21</p>
    <p>This should be stripped along with the bible line.</p>
  </div>
  <div class="mobile-ad">
    <iframe src="ads.example.com"></iframe>
    <p>Advertisement content that must NOT appear in the extracted block.</p>
  </div>
</body>
</html>
`;

/** Minimal dictionary page HTML for "Oration". */
const dictionaryPageHtml = `
<!DOCTYPE html>
<html>
<body>
  <div class="container">
    <h3 class="dictionaryhead">ORATION</h3>
    <div>
      <p>An elaborate discourse delivered in public; a speech prepared and delivered.</p>
      <p>The definition continues here.</p>
    </div>
    <div class="d-md-none">Mobile-only content not part of definition</div>
  </div>
</body>
</html>
`;

/** Dictionary page where definition contains a Bible occurrence trailer. */
const dictionaryWithBibleHtml = `
<!DOCTYPE html>
<html>
<body>
  <div class="container">
    <h3 class="dictionaryhead">PRAYER</h3>
    <div>
      <p>A solemn address to the Supreme Being.</p>
      <p>First Occurrence in the Bible(KJV): Genesis 20:7 — this must be stripped.</p>
    </div>
    <div class="d-md-none">Mobile</div>
  </div>
</body>
</html>
`;

// ─── Service factory ─────────────────────────────────────────────────────────

function makeService() {
  const prisma = {} as any;
  return new Websters1828Service(prisma);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Websters1828Service.fetchWordOfDay()', () => {
  let fetchMock: jest.SpyInstance;

  afterEach(() => {
    fetchMock?.mockRestore();
  });

  it('extracts the word from the WOTD block and prefers the dictionary page definition', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/Dictionary/')) {
        return new Response(dictionaryPageHtml, { status: 200 });
      }
      return new Response(homepageHtml, { status: 200 });
    });

    const service = makeService();
    const result = await service.fetchWordOfDay();

    expect(result.word).toBe('Oration');
    // Should contain the dictionary-page text, not the homepage block text.
    expect(result.definition).toContain('elaborate discourse');
    expect(result.definition).toContain('speech prepared and delivered');
  });

  it('strips "First Occurrence in the Bible" from the dictionary definition', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/Dictionary/')) {
        return new Response(dictionaryWithBibleHtml, { status: 200 });
      }
      return new Response(
        homepageHtml.replace('Oration', 'Prayer').replace('oration', 'prayer'),
        { status: 200 },
      );
    });

    const service = makeService();
    const result = await service.fetchWordOfDay();

    expect(result.definition).not.toContain('First Occurrence in the Bible');
    expect(result.definition).not.toContain('Genesis 20:7');
    expect(result.definition).toContain('solemn address');
  });

  it('does not capture ad or mobile content after the WOTD block', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/Dictionary/')) {
        return new Response(dictionaryPageHtml, { status: 200 });
      }
      return new Response(homepageHtml, { status: 200 });
    });

    const service = makeService();
    const result = await service.fetchWordOfDay();

    expect(result.definition).not.toContain('Advertisement content');
    expect(result.definition).not.toContain('ads.example.com');
    expect(result.definitionHtml).not.toContain('iframe');
  });

  it('falls back to homepage block definition when dictionary page fails', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/Dictionary/')) {
        return new Response('Not Found', { status: 404 });
      }
      return new Response(homepageHtml, { status: 200 });
    });

    const service = makeService();
    const result = await service.fetchWordOfDay();

    expect(result.word).toBe('Oration');
    // Fallback from the homepage block — should have the block definition, not the bible line.
    expect(result.definition).toContain('elaborate discourse');
    expect(result.definition).not.toContain('First Occurrence in the Bible');
    expect(result.definition).not.toContain('Acts 12:21');
  });

  it('throws when the WOTD block or word cannot be extracted', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response('<html><body><p>No WOTD here</p></body></html>', { status: 200 });
    });

    const service = makeService();
    await expect(service.fetchWordOfDay()).rejects.toThrow();
  });
});
