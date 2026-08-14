import { ScriptureService, ScriptureVerse } from './scripture.service';

const chapterVerses: ScriptureVerse[] = [
  { number: 15, text: 'Verse fifteen.' },
  { number: 16, text: 'Verse sixteen.' },
  { number: 17, text: 'Verse seventeen.' },
  { number: 18, text: 'Verse eighteen.' },
  { number: 19, text: 'Verse nineteen.' },
];

function makeService(): ScriptureService {
  const config = {
    scriptureTranslation: jest.fn(() => 'BSB'),
  } as any;
  const cache = {
    getOrSetJson: jest.fn(async () => chapterVerses),
  } as any;

  return new ScriptureService(config, cache);
}

describe('ScriptureService', () => {
  it('returns exactly the requested verse for a single-verse reference', async () => {
    await expect(makeService().getRef('John 3:16')).resolves.toEqual({
      reference: 'John 3:16',
      translation: 'BSB',
      translationName: 'Berean Standard Bible',
      verses: [{ number: 16, text: 'Verse sixteen.' }],
      text: 'Verse sixteen.',
    });
  });

  it('returns both endpoints for an inclusive verse range', async () => {
    await expect(makeService().getRef('John 3:16-18')).resolves.toEqual({
      reference: 'John 3:16-18',
      translation: 'BSB',
      translationName: 'Berean Standard Bible',
      verses: [
        { number: 16, text: 'Verse sixteen.' },
        { number: 17, text: 'Verse seventeen.' },
        { number: 18, text: 'Verse eighteen.' },
      ],
      text: 'Verse sixteen. Verse seventeen. Verse eighteen.',
    });
  });

  it('returns the whole chapter for a chapter-only reference', async () => {
    await expect(makeService().getRef('Rom 9')).resolves.toMatchObject({
      reference: 'Romans 9',
      verses: chapterVerses,
    });
  });

  it('returns only the listed verses for a comma list', async () => {
    await expect(makeService().getRef('John 3:16,18')).resolves.toEqual({
      reference: 'John 3:16,18',
      translation: 'BSB',
      translationName: 'Berean Standard Bible',
      verses: [
        { number: 16, text: 'Verse sixteen.' },
        { number: 18, text: 'Verse eighteen.' },
      ],
      text: 'Verse sixteen. Verse eighteen.',
    });
  });
});
