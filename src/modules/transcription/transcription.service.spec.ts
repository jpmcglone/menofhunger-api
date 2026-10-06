import { transcriptFields } from '../messages/message.dto';

describe('transcriptFields', () => {
  it('hides unfinished and failed transcripts', () => {
    expect(transcriptFields({ transcriptStatus: null, transcript: null })).toEqual({ transcriptStatus: null, transcript: null });
    expect(transcriptFields({ transcriptStatus: 'processing', transcript: null })).toEqual({ transcriptStatus: 'pending', transcript: null });
    expect(transcriptFields({ transcriptStatus: 'failed', transcript: 'x' })).toEqual({ transcriptStatus: 'failed', transcript: null });
  });
  it('returns ready text and treats silence as no text', () => {
    expect(transcriptFields({ transcriptStatus: 'ready', transcript: ' Hello ' })).toEqual({ transcriptStatus: 'ready', transcript: 'Hello' });
    expect(transcriptFields({ transcriptStatus: 'ready', transcript: '' })).toEqual({ transcriptStatus: 'ready', transcript: null });
  });
});
