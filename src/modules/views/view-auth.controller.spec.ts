import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AuthService } from '../auth/auth.service';
import { PostViewsController } from '../post-views/post-views.controller';
import { PostViewsService } from '../post-views/post-views.service';
import { ArticleViewsController } from '../article-views/article-views.controller';
import { ArticleViewsService } from '../article-views/article-views.service';

// Exercise the real optional-auth guard, cookie parser and parameter decorators.
describe.each(['posts', 'articles'])('%s view identity HTTP boundary', (resource) => {
  let app: INestApplication;
  const views = { markViewedBatch: jest.fn(async () => []) };
  const body = {
    [resource === 'posts' ? 'postIds' : 'articleIds']: ['seen-before'],
    anon_id: 'anonymous_browser',
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PostViewsController, ArticleViewsController],
      providers: [
        { provide: PostViewsService, useValue: views },
        { provide: ArticleViewsService, useValue: views },
        {
          provide: AuthService,
          useValue: {
            meFromSessionToken: async (token?: string) =>
              token === 'valid' ? { user: { id: 'john' }, renewed: false } : null,
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());

  it.each([undefined, 'expired'])(
    'never writes a guest view when required authentication fails (%s)',
    async (token) => {
      const req = request(app.getHttpServer()).post(`/${resource}/views`);
      if (token) req.set('Cookie', `moh_session=${token}`);
      await req.send({ ...body, require_auth: true }).expect(401);
      expect(views.markViewedBatch).not.toHaveBeenCalled();
    },
  );
  it('rejects an invalid session from older clients without the new flag', async () => {
    await request(app.getHttpServer())
      .post(`/${resource}/views`)
      .set('Cookie', 'moh_session=expired')
      .send(body)
      .expect(401);
    expect(views.markViewedBatch).not.toHaveBeenCalled();
  });
  it.each([true, undefined])(
    'attributes cookie-authenticated views to John, even with an anonymous ID (%s)',
    async (require_auth) => {
      await request(app.getHttpServer())
        .post(`/${resource}/views`)
        .set('Cookie', 'moh_session=valid')
        .send({ ...body, require_auth })
        .expect(200);
      expect(views.markViewedBatch).toHaveBeenCalledWith('john', ['seen-before'], 'anonymous_browser', null);
    },
  );
  it('preserves genuine guest views without a session', async () => {
    await request(app.getHttpServer()).post(`/${resource}/views`).send(body).expect(200);
    expect(views.markViewedBatch).toHaveBeenCalledWith(null, ['seen-before'], 'anonymous_browser', null);
  });
  it('preserves the shipped iOS request without an anonymous ID or new flag', async () => {
    await request(app.getHttpServer())
      .post(`/${resource}/views`)
      .set('Cookie', 'moh_session=valid')
      .send({
        [resource === 'posts' ? 'postIds' : 'articleIds']: ['seen-before'],
        source: 'ios',
      })
      .expect(200);
    expect(views.markViewedBatch).toHaveBeenCalledWith('john', ['seen-before'], null, 'ios');
  });
});
