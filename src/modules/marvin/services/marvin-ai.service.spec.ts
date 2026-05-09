/**
 * Unit tests for MarvinAIService multimodal payload assembly.
 *
 * We intercept the OpenAI Responses API call by mocking the `openai` module
 * so these tests run without a real API key or network.
 */

import { MarvinAIService } from './marvin-ai.service';
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

function makeService(opts?: { visionEnabled?: boolean; visionModes?: string[] }) {
  const appConfig: any = {
    marvOpenAI: jest.fn(() => ({
      apiKey: 'sk-test',
      promptId: 'pmpt_test',
      promptVersion: null,
      fastModel: MARV_DEFAULT_FAST_MODEL,
      regularModel: MARV_DEFAULT_REGULAR_MODEL,
      smartModel: MARV_DEFAULT_SMART_MODEL,
      webSearchEnabled: false,
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
});
