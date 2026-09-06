import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state.mjs';
import { MohApi, normalizeBaseUrl, sanitize } from '../src/api.mjs';

export async function fixture(t, fetchImpl) {
  const directory = await mkdtemp(join(tmpdir(), 'moh-mcp-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory);
  const api = new MohApi({ store, fetchImpl });
  await store.write(api.credentials, {
    baseUrl: api.baseUrl,
    token: 'test-session-secret',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  return { store, api, directory };
}

test('API requests reuse only the intended session, preserve pagination and never follow redirects', async (t) => {
  let received;
  const { api, store } = await fixture(t, async (url, options) => {
    received = { url, options };
    return Response.json(
      { data: [{ id: 'f1' }], pagination: { nextCursor: 'f2' } },
      {
        headers: {
          'set-cookie': `moh_session=renewed-secret; Expires=${new Date(Date.now() + 86400000).toUTCString()}; HttpOnly`,
        },
      },
    );
  });
  const result = await api.get('admin/feedback', { limit: 5, q: 'a & b' });
  assert.equal(
    received.options.headers.Cookie,
    'moh_session=test-session-secret',
  );
  assert.equal(received.options.headers.Origin, 'https://api.menofhunger.com');
  assert.equal(received.options.redirect, 'error');
  assert.equal(received.url.searchParams.get('q'), 'a & b');
  assert.equal(result.pagination.nextCursor, 'f2');
  assert.ok(result.source.fetchedAt);
  assert.equal((await api.session()).token, 'renewed-secret');
  assert.equal((await stat(store.path(api.credentials))).mode & 0o777, 0o600);
});

test('credentials are not sent when expired, for another environment, or to unsupported routes', async (t) => {
  let calls = 0;
  const { api, store } = await fixture(t, async () => {
    calls++;
    return Response.json({ data: {} });
  });
  for (const path of [
    'https://evil.test',
    '../admin/users',
    'admin/users/id/ban',
    'messages/conversations',
    'auth/me?evil=1',
  ]) {
    await assert.rejects(api.get(path), /not available/);
  }
  await store.write(api.credentials, {
    baseUrl: 'https://other.test/v1',
    token: 'secret',
    expiresAt: '2099-01-01T00:00:00Z',
  });
  await assert.rejects(api.get('admin/analytics'), /not signed in/);
  await store.write(api.credentials, {
    baseUrl: api.baseUrl,
    token: 'secret',
    expiresAt: '2000-01-01T00:00:00Z',
  });
  await assert.rejects(api.get('admin/analytics'), /not signed in/);
  assert.equal(calls, 0);
});

test('errors and large responses do not expose response secrets or retry requests', async (t) => {
  let count = 0;
  const { api } = await fixture(t, async () => {
    count++;
    return Response.json(
      { meta: { message: 'secret-token' } },
      { status: 500 },
    );
  });
  await assert.rejects(
    api.get('admin/analytics'),
    (error) => error.status === 500 && !error.message.includes('secret-token'),
  );
  assert.equal(count, 1);
  api.fetch = async () => Response.json({ data: 'x'.repeat(2_000_001) });
  await assert.rejects(api.get('admin/analytics'), /too large/);
});

test('administrator verification rejects non-admin and impersonated sessions', async (t) => {
  let data = { siteAdmin: false };
  const { api } = await fixture(t, async () => Response.json({ data }));
  await assert.rejects(api.identity(), /administrator/);
  data = { siteAdmin: true, impersonation: { adminUserId: 'admin' } };
  await assert.rejects(api.identity(), /administrator/);
  data = { siteAdmin: true, accountSwitch: { operatorUserId: 'admin' } };
  await assert.rejects(api.identity(), /administrator/);
});

test('private state rejects permissive files, symlinks, and traversal', async (t) => {
  const { store } = await fixture(t, fetch);
  assert.throws(() => store.path('../session.json'), /Invalid/);
  await store.write('private.json', { value: 1 });
  await chmod(store.path('private.json'), 0o644);
  await assert.rejects(store.read('private.json'), /private/);
  await symlink(store.path('private.json'), store.path('linked.json'));
  await assert.rejects(store.read('linked.json'));
});

test('base URLs and recursive contact-field redaction', () => {
  assert.equal(
    normalizeBaseUrl('http://127.0.0.1:3001/v1/'),
    'http://127.0.0.1:3001/v1',
  );
  for (const url of [
    'http://api.menofhunger.com/v1',
    'https://user:password@api.menofhunger.com/v1',
    'https://api.menofhunger.com/v1?key=secret',
    'https://api.menofhunger.com/',
  ]) {
    assert.throws(() => normalizeBaseUrl(url));
  }
  assert.deepEqual(
    sanitize({
      data: [
        {
          name: 'Member',
          phone: '+1555',
          nested: { tokenHash: 'secret', premium: true },
        },
      ],
      email: 'private',
    }),
    { data: [{ name: 'Member', nested: { premium: true } }] },
  );
});
