import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state.mjs';
import { MohApi } from '../src/api.mjs';
import { createTools } from '../src/tools.mjs';
import { describeTools } from '../src/commands.mjs';

async function setup(t, { failPost = false, wrongIdentity = false, failRestore = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'moh-publish-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory);
  const admin = { id: 'admin', username: 'john', accountKind: 'person', siteAdmin: true };
  const page = { id: 'page', username: 'mohnews', accountKind: 'page', accountSwitch: { operatorUserId: 'admin' } };
  let current = admin;
  let cookie = 'admin-token';
  const writes = [];
  const api = new MohApi({ store, fetchImpl: async (url, options) => {
    assert.equal(options.headers.Cookie, `moh_session=${cookie}`);
    const route = url.pathname.replace('/v1/', '');
    if (route === 'auth/me') return Response.json({ data: current });
    if (route === 'admin/feedback') {
      return Response.json({ data: [] }, { status: current.siteAdmin ? 200 : 404 });
    }
    if (route === 'auth/accounts') return Response.json({ data: [admin, page] });
    const body = JSON.parse(options.body);
    writes.push({ route, body, actor: current.id });
    if (route === 'auth/switch') {
      if (failRestore && body.userId === 'admin') return Response.json({ data: null }, { status: 500 });
      current = body.userId === 'admin' || wrongIdentity ? admin : page;
      cookie = `${current.id}-rotated`;
      return Response.json({ data: { user: current } }, { headers: {
        'set-cookie': `moh_session=${cookie}; Expires=${new Date(Date.now() + 3600000).toUTCString()}; HttpOnly`,
      } });
    }
    if (route === 'posts') {
      if (failPost) throw new Error('connection lost after commit');
      return Response.json({ data: { post: { id: 'post1', author: { id: current.id, username: current.username }, ...body } } });
    }
    throw new Error(`Unexpected route: ${route}`);
  } });
  await store.write(api.credentials, { baseUrl: api.baseUrl, token: cookie, expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const tools = createTools({ api, store });
  return { store, api, tools, writes, publish: tools.find((tool) => tool.name === 'publish_post') };
}

test('publishes linked public text as an operated page, rotates credentials, and restores admin', async (t) => {
  const { publish, api, writes } = await setup(t);
  const body = 'Today’s news. Source: https://example.com/news';
  const result = await publish.execute({ authorUsername: '@MOHNews', body });
  assert.equal(result.published, true);
  assert.equal(result.administratorRestored, true);
  assert.equal(result.data.post.author.username, 'mohnews');
  assert.equal(result.data.post.body, body);
  assert.deepEqual(writes, [
    { route: 'auth/switch', body: { userId: 'page' }, actor: 'admin' },
    { route: 'posts', body: { body, visibility: 'public' }, actor: 'page' },
    { route: 'auth/switch', body: { userId: 'admin' }, actor: 'page' },
  ]);
  assert.equal((await api.identity()).id, 'admin');
  assert.ok(!JSON.stringify(result).includes('rotated'));
});

test('personal publishing avoids account switching; unknown authors and invalid text never write', async (t) => {
  const { publish, writes } = await setup(t);
  for (const args of [{ body: 'news' }, { authorUsername: 'john', body: ' ' },
    { authorUsername: 'john', body: 'x'.repeat(1001) },
    { authorUsername: 'john', body: 'news', visibility: 'onlyMe' }])
    await assert.rejects(publish.execute(args));
  await assert.rejects(publish.execute({ authorUsername: 'notmyaccount', body: 'news' }), /page you operate/);
  assert.equal(writes.length, 0);
  await publish.execute({ authorUsername: 'john', body: 'news' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].actor, 'admin');
});

test('failed author switching never falls back to personal posting', async (t) => {
  const { publish, writes } = await setup(t, { wrongIdentity: true });
  await assert.rejects(publish.execute({ authorUsername: 'mohnews', body: 'news' }), /does not match/);
  assert.equal(writes.filter((item) => item.route === 'posts').length, 0);
});

test('ambiguous publishing failures restore admin and never retry the post', async (t) => {
  const { publish, api, writes } = await setup(t, { failPost: true });
  await assert.rejects(publish.execute({ authorUsername: 'mohnews', body: 'news' }), /Publication may have occurred/);
  assert.equal(writes.filter((item) => item.route === 'posts').length, 1);
  assert.equal((await api.identity()).id, 'admin');
});

test('restoration failure preserves confirmed publication and warns without retrying', async (t) => {
  const { publish, writes } = await setup(t, { failRestore: true });
  const result = await publish.execute({ authorUsername: 'mohnews', body: 'news' });
  assert.equal(result.published, true);
  assert.equal(result.administratorRestored, false);
  assert.match(result.warning, /moh login/);
  assert.equal(writes.filter((item) => item.route === 'posts').length, 1);
});

test('publishing lock excludes concurrent processes and releases after failures', async (t) => {
  const { store, api } = await setup(t);
  const secondStore = new StateStore(store.directory);
  await assert.rejects(store.withPublishingLock(api.baseUrl, async () => {
    await assert.rejects(secondStore.withPublishingLock(api.baseUrl, () => assert.fail('must not execute')), /already in progress/);
    throw new Error('test failure');
  }), /test failure/);
  assert.equal(await secondStore.withPublishingLock(api.baseUrl, async () => 'released'), 'released');
});

test('read-only hosted integrations never expose publishing tools', async (t) => {
  const { api, tools } = await setup(t);
  const hosted = createTools({ api, localArtifacts: false });
  for (const name of ['publish_post', 'publishing_accounts', 'get_post'])
    assert.ok(!hosted.some((tool) => tool.name === name));
  assert.equal(describeTools(tools).find((tool) => tool.name === 'publish_post').effects, 'remote-write');
});
