import { AiUtilityService } from './ai-utility.service';

const mockResponsesCreate = jest.fn();

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    responses: { create: mockResponsesCreate },
  })),
}));

function makeService(apiKey = 'sk-test') {
  const appConfig: any = {
    marvOpenAI: jest.fn(() => ({ apiKey })),
  };
  return new AiUtilityService(appConfig);
}

describe('AiUtilityService', () => {
  beforeEach(() => {
    mockResponsesCreate.mockReset();
  });

  it('returns null when OpenAI is not configured', async () => {
    const svc = makeService('');
    expect(svc.isConfigured()).toBe(false);
    await expect(
      svc.complete({ model: 'gpt-5.6-luna', instructions: 'x', userMessage: 'y' }),
    ).resolves.toBeNull();
    expect(mockResponsesCreate).not.toHaveBeenCalled();
  });

  it('sends instructions without a stored prompt id', async () => {
    mockResponsesCreate.mockResolvedValueOnce({ output_text: '["faith"]' });
    const svc = makeService();
    const result = await svc.complete({
      model: 'gpt-5.6-luna',
      instructions: 'Assign topics.',
      userMessage: 'I prayed this morning.',
      cacheKey: 'topics:classify',
    });
    expect(result).toEqual({ text: '["faith"]', modelUsed: 'gpt-5.6-luna' });
    const payload = mockResponsesCreate.mock.calls[0]?.[0];
    expect(payload.prompt).toBeUndefined();
    expect(payload.instructions).toBe('Assign topics.');
    expect(payload.input).toBe('I prayed this morning.');
    expect(payload.store).toBe(false);
    expect(payload.prompt_cache_key).toBe('topics:classify');
  });
});
