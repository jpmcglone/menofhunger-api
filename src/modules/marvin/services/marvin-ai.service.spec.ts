/**
 * Unit tests for MarvinAIService multimodal payload assembly.
 *
 * We intercept the OpenAI Responses API call by mocking the `openai` module
 * so these tests run without a real API key or network.
 */

import { MarvinAIService, marvReasoningEffort } from './marvin-ai.service';
import { MARV_LOCAL_TOOL_NAMES } from '../marvin-ai-tools';
import {
  MARV_DEFAULT_FAST_MODEL,
  MARV_DEFAULT_REGULAR_MODEL,
  MARV_DEFAULT_SMART_MODEL,
} from '../marvin-models';

// Capture the args passed to openai.responses.create so we can assert the payload shape.
const mockResponsesCreate = jest.fn();
const mockResponses = { create: mockResponsesCreate };

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    responses: mockResponses,
  })),
}));

function makeService(opts?: {
  visionEnabled?: boolean;
  visionModes?: string[];
  webSearchEnabled?: boolean;
  promptVersion?: string | null;
}) {
  const appConfig: any = {
    marvOpenAI: jest.fn(() => ({
      apiKey: 'sk-test',
      promptId: 'pmpt_test',
      promptVersion: opts?.promptVersion ?? null,
      fastModel: MARV_DEFAULT_FAST_MODEL,
      regularModel: MARV_DEFAULT_REGULAR_MODEL,
      smartModel: MARV_DEFAULT_SMART_MODEL,
      webSearchEnabled: opts?.webSearchEnabled ?? false,
      webSearchModes: ['regular', 'smart'],
      webSearchMaxOutputTokens: 4096,
      visionEnabled: opts?.visionEnabled ?? true,
      visionModes: opts?.visionModes ?? ['regular', 'smart'],
      visionMaxImagesPerTurn: 4,
    })),
    marvLimits: jest.fn(() => ({
      publicMaxInputTokens: 8000,
      privateMaxInputTokens: 4000,
      maxOutputTokens: 1024,
    })),
  };
  return new MarvinAIService(appConfig);
}

function makeSuccessResponse(text: string) {
  return {
    id: 'resp-test',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 50, output_tokens: 20, input_tokens_details: { cached_tokens: 0 } },
    status: 'completed',
  };
}

const baseReq = {
  source: 'private_session' as const,
  mode: 'regular' as const,
  developerNote: 'dev note',
  userMessage: 'Hello',
  dispatchTool: jest.fn(async () => '{}'),
  toolContext: { requesterUserId: 'u-1' },
};

describe('MarvinAIService multimodal payload assembly', () => {
  beforeEach(() => {
    mockResponsesCreate.mockReset();
    mockResponsesCreate.mockResolvedValue(makeSuccessResponse('test reply'));
  });

  it('uses plain string for user content when no images are provided', async () => {
    const svc = makeService();
    await svc.respond({ ...baseReq, imageUrls: [] });
    const call = mockResponsesCreate.mock.calls[0]?.[0];
    const userMsg = call?.input?.find((i: any) => i.role === 'user');
    expect(typeof userMsg?.content).toBe('string');
    expect(userMsg?.content).toBe('Hello');
  });

  it('uses content-parts array when images are provided and vision is enabled', async () => {
    const svc = makeService({ visionEnabled: true, visionModes: ['regular', 'smart'] });
    const imageUrls = ['https://cdn.test/img1.jpg', 'https://cdn.test/img2.jpg'];
    await svc.respond({ ...baseReq, imageUrls });
    const call = mockResponsesCreate.mock.calls[0]?.[0];
    const userMsg = call?.input?.find((i: any) => i.role === 'user');
    expect(Array.isArray(userMsg?.content)).toBe(true);
    expect(userMsg.content[0]).toMatchObject({ type: 'input_text', text: 'Hello' });
    expect(userMsg.content[1]).toMatchObject({ type: 'input_image', image_url: 'https://cdn.test/img1.jpg' });
    expect(userMsg.content[2]).toMatchObject({ type: 'input_image', image_url: 'https://cdn.test/img2.jpg' });
  });

  it('ignores imageUrls when vision is disabled', async () => {
    const svc = makeService({ visionEnabled: false });
    await svc.respond({ ...baseReq, imageUrls: ['https://cdn.test/img1.jpg'] });
    const call = mockResponsesCreate.mock.calls[0]?.[0];
    const userMsg = call?.input?.find((i: any) => i.role === 'user');
    expect(typeof userMsg?.content).toBe('string');
  });

  it('ignores imageUrls when mode is not in visionModes', async () => {
    const svc = makeService({ visionEnabled: true, visionModes: ['smart'] }); // regular excluded
    await svc.respond({ ...baseReq, mode: 'regular', imageUrls: ['https://cdn.test/img1.jpg'] });
    const call = mockResponsesCreate.mock.calls[0]?.[0];
    const userMsg = call?.input?.find((i: any) => i.role === 'user');
    expect(typeof userMsg?.content).toBe('string');
  });

  it('caps imageUrls to visionMaxImagesPerTurn', async () => {
    const svc = makeService({ visionEnabled: true, visionModes: ['regular'] });
    // Override to cap at 2
    (svc as any).appConfig.marvOpenAI.mockReturnValue({
      apiKey: 'sk-test', promptId: 'pmpt_test', promptVersion: null,
      fastModel: MARV_DEFAULT_FAST_MODEL, regularModel: MARV_DEFAULT_REGULAR_MODEL, smartModel: MARV_DEFAULT_SMART_MODEL,
      webSearchEnabled: false, webSearchModes: [], webSearchMaxOutputTokens: 4096,
      visionEnabled: true, visionModes: ['regular'], visionMaxImagesPerTurn: 2,
    });
    const imageUrls = ['https://cdn.test/1.jpg', 'https://cdn.test/2.jpg', 'https://cdn.test/3.jpg'];
    await svc.respond({ ...baseReq, imageUrls });
    const call = mockResponsesCreate.mock.calls[0]?.[0];
    const userMsg = call?.input?.find((i: any) => i.role === 'user');
    // input_text + 2 input_image = 3 parts total
    expect(userMsg.content).toHaveLength(3);
  });

  it('reports imagesAttached = 0 when no images were sent', async () => {
    const svc = makeService();
    const result = await svc.respond({ ...baseReq });
    expect(result.imagesAttached).toBe(0);
  });

  it('reports imagesAttached = number of images sent', async () => {
    const svc = makeService({ visionEnabled: true, visionModes: ['regular'] });
    const result = await svc.respond({ ...baseReq, imageUrls: ['https://cdn.test/1.jpg', 'https://cdn.test/2.jpg'] });
    expect(result.imagesAttached).toBe(2);
  });

  it('estimates cost with GPT-5.6 Terra rates and records the model id', async () => {
    const svc = makeService();
    const result = await svc.respond({ ...baseReq });
    expect(result.modelUsed).toBe(MARV_DEFAULT_REGULAR_MODEL);
    // 50 in * $2/M + 20 out * $12/M
    expect(result.estimatedCostUsd).toBe(0.00034);
  });
});

function apiError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function makeIncompleteResponse(id: string) {
  return {
    id,
    status: 'incomplete',
    output: [],
    usage: { input_tokens: 80, output_tokens: 1024, input_tokens_details: { cached_tokens: 0 } },
  };
}

describe('MarvinAIService failure recovery', () => {
  beforeEach(() => {
    mockResponsesCreate.mockReset();
  });

  it('drops a stale previous_response_id and retries the same turn', async () => {
    mockResponsesCreate
      .mockRejectedValueOnce(apiError(400, 'No tool output found for function call call_abc'))
      .mockResolvedValueOnce(makeSuccessResponse('recovered'));
    const svc = makeService();
    const result = await svc.respond({ ...baseReq, previousResponseId: 'resp-old' });
    expect(result.text).toBe('recovered');
    expect(mockResponsesCreate).toHaveBeenCalledTimes(2);
    expect(mockResponsesCreate.mock.calls[0]?.[0]?.previous_response_id).toBe('resp-old');
    expect(mockResponsesCreate.mock.calls[1]?.[0]?.previous_response_id).toBeUndefined();
  });

  it('retries a 429 and then succeeds', async () => {
    mockResponsesCreate
      .mockRejectedValueOnce(apiError(429, 'Rate limit exceeded'))
      .mockResolvedValueOnce(makeSuccessResponse('after backoff'));
    const svc = makeService();
    const result = await svc.respond({ ...baseReq });
    expect(result.text).toBe('after backoff');
    expect(mockResponsesCreate).toHaveBeenCalledTimes(2);
  });

  it('recovers incomplete-with-no-text via a chained retry', async () => {
    mockResponsesCreate
      .mockResolvedValueOnce(makeIncompleteResponse('resp-incomplete'))
      .mockResolvedValueOnce(makeSuccessResponse('finished thinking'));
    const svc = makeService();
    const result = await svc.respond({ ...baseReq });
    expect(result.text).toBe('finished thinking');
    expect(result.errorCode).toBeUndefined();
    expect(mockResponsesCreate.mock.calls[1]?.[0]?.previous_response_id).toBe('resp-incomplete');
    expect(mockResponsesCreate.mock.calls[1]?.[0]?.tool_choice).toBe('none');
  });

  it('falls back to a fresh answer-now turn when the chained retry is empty', async () => {
    mockResponsesCreate
      .mockResolvedValueOnce(makeIncompleteResponse('resp-incomplete'))
      .mockResolvedValueOnce(makeIncompleteResponse('resp-retry'))
      .mockResolvedValueOnce(makeSuccessResponse('fresh answer'));
    const svc = makeService();
    const result = await svc.respond({ ...baseReq });
    expect(result.text).toBe('fresh answer');
    expect(mockResponsesCreate.mock.calls[2]?.[0]?.previous_response_id).toBeUndefined();
    expect(mockResponsesCreate.mock.calls[2]?.[0]?.tool_choice).toBe('none');
  });

  it('dispatches parallel tool calls in one round then replies', async () => {
    mockResponsesCreate
      .mockResolvedValueOnce({
        id: 'resp-tools',
        status: 'completed',
        output: [
          { type: 'function_call', call_id: 'c1', name: 'get_user_context_card', arguments: '{"username":"peter"}' },
          { type: 'function_call', call_id: 'c2', name: 'get_user_context_card', arguments: '{"username":"lamarm"}' },
        ],
        usage: { input_tokens: 20, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } },
      })
      .mockResolvedValueOnce(makeSuccessResponse('Peter and Lamar are both members.'));
    const dispatchTool = jest.fn(async () => '{"ok":true}');
    const svc = makeService();
    const result = await svc.respond({ ...baseReq, dispatchTool });
    expect(dispatchTool).toHaveBeenCalledTimes(2);
    expect(result.text).toContain('Peter');
    expect(result.toolCallCount).toBe(2);
    const followUp = mockResponsesCreate.mock.calls[1]?.[0];
    expect(followUp?.input).toEqual([
      expect.objectContaining({ type: 'function_call_output', call_id: 'c1' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'c2' }),
    ]);
  });
});

describe('MarvinAIService request knobs', () => {
  beforeEach(() => {
    mockResponsesCreate.mockReset();
    mockResponsesCreate.mockResolvedValue(makeSuccessResponse('test reply'));
  });

  it('maps mode to reasoning effort and always sends low verbosity', async () => {
    expect(marvReasoningEffort('fast', false)).toBe('low');
    expect(marvReasoningEffort('regular', false)).toBe('low');
    expect(marvReasoningEffort('smart', false)).toBe('medium');
    expect(marvReasoningEffort('fast', true)).toBe('high');

    const svc = makeService();
    await svc.respond({ ...baseReq, mode: 'fast' });
    await svc.respond({ ...baseReq, mode: 'regular' });
    await svc.respond({ ...baseReq, mode: 'smart' });
    await svc.respond({ ...baseReq, mode: 'fast', elevateReasoning: true });

    expect(mockResponsesCreate.mock.calls[0]?.[0]?.reasoning).toEqual({ effort: 'low' });
    expect(mockResponsesCreate.mock.calls[0]?.[0]?.text).toEqual({ verbosity: 'low' });
    expect(mockResponsesCreate.mock.calls[1]?.[0]?.reasoning).toEqual({ effort: 'low' });
    expect(mockResponsesCreate.mock.calls[2]?.[0]?.reasoning).toEqual({ effort: 'medium' });
    expect(mockResponsesCreate.mock.calls[3]?.[0]?.reasoning).toEqual({ effort: 'high' });
  });

  it('pins prompt version when configured', async () => {
    const svc = makeService({ promptVersion: '12' });
    await svc.respond({ ...baseReq });
    expect(mockResponsesCreate.mock.calls[0]?.[0]?.prompt).toEqual({ id: 'pmpt_test', version: '12' });
  });

  it('omits prompt version when unset so OpenAI uses latest', async () => {
    const svc = makeService();
    await svc.respond({ ...baseReq });
    expect(mockResponsesCreate.mock.calls[0]?.[0]?.prompt).toEqual({ id: 'pmpt_test' });
  });

  it('registers every local function tool', async () => {
    const svc = makeService();
    await svc.respond({ ...baseReq });
    const tools = mockResponsesCreate.mock.calls[0]?.[0]?.tools ?? [];
    const names = tools
      .filter((t: { type?: string; name?: string }) => t.type === 'function')
      .map((t: { name: string }) => t.name)
      .sort();
    expect(names).toEqual([...MARV_LOCAL_TOOL_NAMES].sort());
  });

  it('attaches hosted web_search with a low context size', async () => {
    const svc = makeService({ webSearchEnabled: true });
    await svc.respond({ ...baseReq, mode: 'regular' });
    const tools = mockResponsesCreate.mock.calls[0]?.[0]?.tools ?? [];
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'web_search', search_context_size: 'low' }),
      ]),
    );
    expect(tools.some((t: { type?: string }) => t.type === 'web_search_preview')).toBe(false);
  });

  it('does not attach web_search on Fast', async () => {
    const svc = makeService({ webSearchEnabled: true });
    await svc.respond({ ...baseReq, mode: 'fast' });
    const tools = mockResponsesCreate.mock.calls[0]?.[0]?.tools ?? [];
    expect(tools.some((t: { type?: string }) => t.type === 'web_search')).toBe(false);
  });

  it('absorbs reasoning tokens from usage details', async () => {
    mockResponsesCreate.mockResolvedValueOnce({
      ...makeSuccessResponse('thoughtful'),
      usage: {
        input_tokens: 50,
        output_tokens: 80,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 60 },
      },
    });
    const svc = makeService();
    const result = await svc.respond({ ...baseReq });
    expect(result.reasoningTokens).toBe(60);
    expect(result.outputTokens).toBe(80);
  });

  it('attaches leftover vision slots from list_public_posts image URLs', async () => {
    mockResponsesCreate
      .mockResolvedValueOnce({
        id: 'resp-tools',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'c1',
            name: 'list_public_posts',
            arguments: '{}',
          },
        ],
        usage: { input_tokens: 20, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } },
      })
      .mockResolvedValueOnce(makeSuccessResponse('Alice posted a lift photo.'));
    const dispatchTool = jest.fn(async () =>
      JSON.stringify({
        posts: [{ id: 'p-1', imageUrls: ['https://cdn.test/lift.jpg'] }],
      }),
    );
    const svc = makeService({ visionEnabled: true, visionModes: ['regular'] });
    const result = await svc.respond({ ...baseReq, dispatchTool });
    expect(result.imagesAttached).toBe(1);
    const followUp = mockResponsesCreate.mock.calls[1]?.[0];
    expect(followUp?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call_output', call_id: 'c1' }),
        expect.objectContaining({ role: 'user' }),
      ]),
    );
    const imageMsg = followUp.input.find((i: { role?: string }) => i.role === 'user');
    expect(imageMsg.content[0]).toMatchObject({
      type: 'input_image',
      image_url: 'https://cdn.test/lift.jpg',
    });
  });
});

describe('MarvinAIService.extractToolImageUrls', () => {
  it('reads imageUrls from a single post and a list', () => {
    expect(
      MarvinAIService.extractToolImageUrls(
        JSON.stringify({ imageUrls: ['https://cdn.test/a.jpg'] }),
      ),
    ).toEqual(['https://cdn.test/a.jpg']);
    expect(
      MarvinAIService.extractToolImageUrls(
        JSON.stringify({
          posts: [{ imageUrls: ['https://cdn.test/b.jpg'] }, { imageUrls: ['not-a-url'] }],
        }),
      ),
    ).toEqual(['https://cdn.test/b.jpg']);
  });
});
