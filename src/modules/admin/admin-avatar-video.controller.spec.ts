import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { ApiExceptionFilter } from '../../common/filters/api-exception.filter';
import { AuthService } from '../auth/auth.service';
import { AvatarVideoService } from '../uploads/avatar-video.service';
import { AdminAvatarVideoController } from './admin-avatar-video.controller';
import { AdminGuard } from './admin.guard';

describe('Admin avatar video HTTP boundary', () => {
  let app: INestApplication;
  const videos = { canSet: jest.fn(async () => true), init: jest.fn(async () => ({ id: 'job' })),
    commit: jest.fn(async () => ({ status: 'queued' })), status: jest.fn(async () => ({ status: 'ready' })),
    cancel: jest.fn(async () => ({ status: 'cancelled' })) };
  const base = '/v1/admin/users/target/uploads/avatar/video';
  const selection = { startSeconds: 0, durationSeconds: 7, crop: { x: 0, y: 0, width: 1, height: 1 } };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AdminAvatarVideoController], providers: [AdminGuard,
        { provide: AvatarVideoService, useValue: videos },
        { provide: AuthService, useValue: {
          meFromSessionToken: async (token: string) => !token || token === 'missing' ? null : ({
            user: { id: 'admin', siteAdmin: token !== 'member' }, renewed: false,
            impersonatedByUserId: token === 'impersonated' ? 'other' : null,
            operatedByUserId: token === 'operated' ? 'other' : null,
          }),
        } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new ApiExceptionFilter());
    app.setGlobalPrefix('v1');
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => jest.clearAllMocks());

  it.each([['get', 'capabilities'], ['post', 'init'], ['post', 'job/commit'], ['get', 'job'], ['delete', 'job']] as const)(
    'hides %s %s from non-admin, impersonated, and operated sessions', async (method, suffix) => {
      for (const token of ['missing', 'member', 'impersonated', 'operated']) {
        await request(app.getHttpServer())[method](`${base}/${suffix}`).set('Cookie', `moh_session=${token}`).expect(404);
      }
      for (const method of Object.values(videos)) expect(method).not.toHaveBeenCalled();
    });
  it('targets the selected profile and trusts only the authenticated admin identity', async () => {
    await request(app.getHttpServer()).get(`${base}/capabilities`).set('Cookie', 'moh_session=admin')
      .expect(200).expect(({ body }) => expect(body.data).toMatchObject({ canSet: true, maxDurationSeconds: 7 }));
    await request(app.getHttpServer()).post(`${base}/init`).set('Cookie', 'moh_session=admin')
      .send({ contentType: 'video/mp4', userId: 'wrong', adminUserId: 'spoof' }).expect(201);
    expect(videos.init).toHaveBeenCalledWith('target', null, 'video/mp4', 'admin');
    await request(app.getHttpServer()).post(`${base}/job/commit`).set('Cookie', 'moh_session=admin').send(selection).expect(201);
    expect(videos.commit).toHaveBeenCalledWith('target', null, 'job', selection, 'admin');
    await request(app.getHttpServer()).get(`${base}/job`).set('Cookie', 'moh_session=admin').expect(200);
    expect(videos.status).toHaveBeenCalledWith('target', 'job');
    await request(app.getHttpServer()).delete(`${base}/job`).set('Cookie', 'moh_session=admin').expect(200);
    expect(videos.cancel).toHaveBeenCalledWith('target', 'job');
  });
  it('rejects selections longer than seven seconds before queueing', async () => {
    await request(app.getHttpServer()).post(`${base}/job/commit`).set('Cookie', 'moh_session=admin')
      .send({ ...selection, durationSeconds: 7.01 }).expect(400);
    expect(videos.commit).not.toHaveBeenCalled();
  });
});
