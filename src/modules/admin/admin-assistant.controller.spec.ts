import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { ApiExceptionFilter } from '../../common/filters/api-exception.filter';
import { AuthService } from '../auth/auth.service';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { TaxonomyController } from '../taxonomy/taxonomy.controller';
import { TaxonomyService } from '../taxonomy/taxonomy.service';
import { AdminAssistantController } from './admin-assistant.controller';
import { AdminAssistantService } from './admin-assistant.service';
import { AdminGuard } from './admin.guard';

jest.mock('../mcp/mcp-tools', () => ({ sharedTools: { capabilities: () => [] } }));

describe('Admin workspace HTTP boundary', () => {
  let app: INestApplication;
  const assistant = { workspace: jest.fn(async () => ({})), ask: jest.fn(async () => ({})), decide: jest.fn(async () => ({})) };
  const taxonomy = { backfillAndSync: jest.fn(async () => ({ done: true })) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AdminAssistantController, TaxonomyController],
      providers: [AdminGuard,
        { provide: AdminAssistantService, useValue: assistant },
        { provide: TaxonomyService, useValue: taxonomy },
        { provide: AuthService, useValue: {
          meFromSessionToken: async (token: string) => token === 'missing' || !token ? null : ({ user: { id: 'owner', siteAdmin: token !== 'member' }, impersonatedByUserId: token === 'impersonated' ? 'other' : null, operatedByUserId: token === 'switched' ? 'other' : null, renewed: false }),
        } },
      ],
    }).overrideGuard(OptionalAuthGuard).useValue({ canActivate: () => true }).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new ApiExceptionFilter());
    app.setGlobalPrefix('v1');
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['get', '/admin/assistant'], ['get', '/admin/assistant/capabilities'],
    ['post', '/admin/assistant/messages'], ['post', '/admin/assistant/actions/00000000-0000-4000-8000-000000000001'],
    ['post', '/taxonomy/backfill'],
  ] as const)('hides %s %s from every non-own-admin session', async (method, path) => {
    for (const token of ['missing', 'member', 'impersonated', 'switched']) {
      await request(app.getHttpServer())[method](`/v1${path}`).set('Cookie', `moh_session=${token}`).expect(404);
    }
    expect(assistant.ask).not.toHaveBeenCalled();
    expect(assistant.decide).not.toHaveBeenCalled();
    expect(taxonomy.backfillAndSync).not.toHaveBeenCalled();
  });
  it('rejects client-supplied tool controls instead of forwarding them to the assistant', async () => {
    await request(app.getHttpServer()).post('/v1/admin/assistant/messages').set('Cookie', 'moh_session=admin')
      .send({ id: '00000000-0000-4000-8000-000000000001', message: 'Hello', tools: ['send_newsletter'] }).expect(400);
    expect(assistant.ask).not.toHaveBeenCalled();
  });
  it('preserves the authorized taxonomy operation through the shared guard', async () => {
    const response = await request(app.getHttpServer()).post('/v1/taxonomy/backfill').set('Cookie', 'moh_session=admin').expect(201);
    expect(response.body).toEqual({ data: { done: true } });
    expect(taxonomy.backfillAndSync).toHaveBeenCalledTimes(1);
  });
});
