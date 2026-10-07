import { TypeSafeService } from './typesafe.service';

const mockSystemOne = jest.fn();
const mockCtor = jest.fn();

jest.mock('@typesafe-ai/sdk', () => ({
  TypeSafeClient: jest.fn().mockImplementation((cfg: unknown) => {
    mockCtor(cfg);
    return { systemOne: mockSystemOne };
  }),
}));

const questions = {
  urgent: { type: 'noul', instructions: 'Escalate now?' },
} as const;

function makeService(apiKey = 'ts-test') {
  const appConfig: any = {
    typeSafe: jest.fn(() => ({ apiKey, model: 'jev-1.13.0', timeoutMs: 4000 })),
  };
  return new TypeSafeService(appConfig);
}

describe('TypeSafeService', () => {
  beforeEach(() => {
    mockSystemOne.mockReset();
    mockCtor.mockReset();
  });

  it('is disabled and makes no call without an API key', async () => {
    const svc = makeService('');
    expect(svc.isConfigured()).toBe(false);
    await expect(svc.decide({ purpose: 'test', state: 'x', questions })).resolves.toBeNull();
    expect(mockCtor).not.toHaveBeenCalled();
    expect(mockSystemOne).not.toHaveBeenCalled();
  });

  it('sends the configured model and returns the typed result', async () => {
    const result = {
      model: 'jev-1.13.0',
      answers: { urgent: { type: 'noul', noul: 0.91 } },
      usage: { input_tokens: 12, output_tokens: 1 },
    };
    mockSystemOne.mockResolvedValueOnce(result);
    const svc = makeService();
    await expect(svc.decide({ purpose: 'test', state: 'charged twice', questions })).resolves.toBe(result);
    expect(mockCtor).toHaveBeenCalledWith({ apiKey: 'ts-test', defaultModel: 'jev-1.13.0', timeout: 4000 });
    expect(mockSystemOne.mock.calls[0][0]).toEqual({
      state: 'charged twice',
      questions,
      model: 'jev-1.13.0',
    });
  });

  it('returns null instead of throwing when the API fails', async () => {
    mockSystemOne.mockRejectedValueOnce(new Error('boom'));
    await expect(makeService().decide({ purpose: 'test', state: 'x', questions })).resolves.toBeNull();
  });
});
