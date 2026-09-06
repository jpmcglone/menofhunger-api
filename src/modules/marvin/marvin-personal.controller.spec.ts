import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { MarvinPersonalController } from './marvin-personal.controller';
import { MarvinPersonalService } from './services/marvin-personal.service';
import { MarvinParticipationService } from './services/marvin-participation.service';
import { AuthService } from '../auth/auth.service';
import { ApiExceptionFilter } from '../../common/filters/api-exception.filter';

describe('personal MARV HTTP boundary', () => {
  let app: INestApplication;
  const auth = { meFromSessionToken: jest.fn(), setSessionCookie: jest.fn() };
  const personal = { list: jest.fn(async () => []), decide: jest.fn(async () => ({ status: 'applied' })) };
  const participation = { suggestions: jest.fn(async () => ({ suggestions: [] })) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [MarvinPersonalController], providers: [
      { provide: AuthService, useValue: auth }, { provide: MarvinPersonalService, useValue: personal },
      { provide: MarvinParticipationService, useValue: participation },
    ] }).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => { jest.clearAllMocks(); auth.meFromSessionToken.mockResolvedValue({ user: { id: 'owner' }, renewed: false }); });
  it('requires authentication and rejects impersonation and operated sessions', async () => {
    auth.meFromSessionToken.mockResolvedValue(null);
    await request(app.getHttpServer()).get('/marvin/actions').expect(401);
    for (const field of ['impersonatedByUserId', 'operatedByUserId']) {
      auth.meFromSessionToken.mockResolvedValue({ user: { id: 'owner' }, [field]: 'operator' });
      await request(app.getHttpServer()).get('/marvin/actions').expect(403);
      await request(app.getHttpServer()).post('/marvin/actions/00000000-0000-4000-8000-000000000000').send({ decision: 'confirm' }).expect(403);
    }
    expect(personal.list).not.toHaveBeenCalled();
    expect(personal.decide).not.toHaveBeenCalled();
  });
  it('derives ownership from the session and accepts only an explicit decision', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    await request(app.getHttpServer()).post(`/marvin/actions/${id}`).send({ decision: 'yes' }).expect(400);
    await request(app.getHttpServer()).post(`/marvin/actions/${id}`).send({ decision: 'confirm', userId: 'other' }).expect(400);
    await request(app.getHttpServer()).post(`/marvin/actions/${id}`).send({ decision: 'confirm' }).expect(201);
    expect(personal.decide).toHaveBeenCalledTimes(1);
    expect(personal.decide).toHaveBeenCalledWith('owner', id, 'confirm');
    const result = await request(app.getHttpServer()).get('/marvin/actions').expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
  });
});
