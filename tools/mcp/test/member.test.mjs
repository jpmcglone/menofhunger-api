import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMemberServer } from '../src/server.mjs';
import { createMemberTools, MemberReadApi } from '../src/member-tools.mjs';
import { memberAllowance } from '../src/allowance.mjs';

const author = { username: 'brother', name: 'Brother', phone: '+15555550100', email: 'b@example.com', premium: true };
const lodgePost = { id: 'p1', body: 'Up early.', author, commentCount: 2, createdAt: '2026-09-22T12:00:00.000Z' };
const groupPost = { id: 'g1', body: 'Group only', author, communityGroupId: 'group-1' };

class FakeApi {
  baseUrl = 'https://api.example/v1';
  calls = [];
  responses = {
    'auth/me': { data: { id: 'u1', username: 'me', name: 'Me', premium: true, phone: '+15555550199', email: 'me@example.com', birthdate: '1990-01-01', bio: 'Hungry.' } },
    posts: { data: [lodgePost, groupPost, { ...lodgePost, id: 'p2', quotedPost: groupPost }], pagination: { nextCursor: 'next' } },
    'posts/p1': { data: { ...lodgePost, parent: { id: 'p0', body: 'Parent', author } } },
    'posts/g1': { data: groupPost },
    'users/brother': { data: { ...author, bio: 'Iron.', followerCount: 3, locationZip: '10001' } },
    notifications: {
      data: [
        { id: 'n1', kind: 'reply', title: 'Brother replied', actorPostId: 'p1', deliveredAt: null, readAt: null, actor: author },
        { id: 'n2', kind: 'message', subjectConversationId: 'c1' },
        { id: 'n3', kind: 'group_post', subjectGroupId: 'group-1' },
        { id: 'n4', kind: 'mention', post: groupPost },
      ],
      pagination: { nextCursor: null, undeliveredCount: 1 },
    },
  };

  async request(path, options) {
    this.calls.push({ path, ...options });
    return { ...(this.responses[path] ?? { data: [] }), source: { url: `${this.baseUrl}/${path}` } };
  }
}

async function connect(t, { api = new FakeApi(), beforeCall, usage } = {}) {
  const server = createMemberServer({ api, webUrl: 'https://menofhunger.com', beforeCall, usage });
  const client = new Client({ name: 'member-test', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(() => client.close());
  return { api, client };
}

test('member catalog is read-only and excludes every admin and write tool', async (t) => {
  const { client } = await connect(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'articles', 'bible_passage', 'connection_status', 'get_article', 'get_post', 'lodge_feed', 'me',
    'member_posts', 'member_profile', 'my_bookmarks', 'my_notifications', 'post_replies', 'search_lodge',
  ]);
  assert.ok(tools.every((tool) => tool.annotations.readOnlyHint === true));
  for (const name of ['publish_post', 'save_draft', 'feedback', 'analytics', 'create_delegated_job', 'search_members'])
    assert.equal(tools.some((tool) => tool.name === name), false);
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), ['catch_up_on_thread', 'lodge_briefing', 'who_should_i_meet']);
});

test('member reader only issues GET requests on allowlisted routes', async () => {
  const api = new FakeApi();
  const reader = new MemberReadApi(api);
  for (const path of ['admin/feedback', 'messages/conversations', 'groups/g1/posts', 'posts/p1/boost', 'auth/accounts', '../admin'])
    await assert.rejects(reader.get(path), /not available to the member connection/);
  await reader.get('posts/p1');
  assert.deepEqual(api.calls.map(({ path, method }) => [path, method]), [['posts/p1', 'GET']]);
  const tools = createMemberTools({ api });
  for (const tool of tools) {
    assert.equal(tool.localWrite, false);
    assert.equal(tool.remoteWrite, false);
  }
});

test('member tools redact contact details, drop group content, and link to the website', async (t) => {
  const { api, client } = await connect(t);
  const me = await client.callTool({ name: 'me', arguments: {} });
  const meText = JSON.stringify(me.structuredContent);
  for (const secret of ['+15555550199', 'me@example.com', '1990-01-01']) assert.equal(meText.includes(secret), false);
  assert.equal(me.structuredContent.data.url, 'https://menofhunger.com/u/me');

  const feed = await client.callTool({ name: 'lodge_feed', arguments: { limit: 5 } });
  assert.deepEqual(feed.structuredContent.data.map((post) => post.id), ['p1', 'p2']);
  assert.equal(feed.structuredContent.data[1].quotedPost, undefined);
  assert.equal(feed.structuredContent.data[0].url, 'https://menofhunger.com/p/p1');
  assert.equal(feed.structuredContent.pagination.nextCursor, 'next');
  assert.equal(JSON.stringify(feed).includes('+15555550100'), false);
  assert.equal(JSON.stringify(feed).includes('Group only'), false);

  const group = await client.callTool({ name: 'get_post', arguments: { postId: 'g1' } });
  assert.equal(group.isError, true);
  assert.match(group.content[0].text, /lives in a group/);

  const profile = await client.callTool({ name: 'member_profile', arguments: { username: '@brother' } });
  assert.equal(profile.structuredContent.data.bio, 'Iron.');
  assert.equal(JSON.stringify(profile).includes('10001'), false);

  const notifications = await client.callTool({ name: 'my_notifications', arguments: {} });
  assert.deepEqual(notifications.structuredContent.data.map((row) => row.id), ['n1']);
  assert.equal(notifications.structuredContent.data[0].seen, false);
  assert.equal(notifications.structuredContent.unseenCount, 1);
  assert.ok(api.calls.every((call) => call.method === 'GET'));
});

class CounterRedis {
  values = new Map();
  async incr(key) { const next = (Number(this.values.get(key)) || 0) + 1; this.values.set(key, String(next)); return next; }
  async expire() {}
  async get(key) { return this.values.get(key) ?? null; }
}

test('daily allowance counts tool calls and stops at the limit with a clear message', async (t) => {
  const redis = new CounterRedis();
  const allowance = memberAllowance(redis, { daily: 2, now: () => Date.parse('2026-09-23T10:00:00Z') });
  const { api, client } = await connect(t, {
    beforeCall: () => allowance.consume('u1'),
    usage: () => allowance.usage('u1'),
  });
  const status = await client.callTool({ name: 'connection_status', arguments: {} });
  assert.deepEqual(status.structuredContent.usage, { used: 1, limit: 2, remaining: 1, resetsAt: '2026-09-24T00:00:00.000Z' });
  assert.equal((await client.callTool({ name: 'lodge_feed', arguments: {} })).isError, undefined);
  const before = api.calls.length;
  const blocked = await client.callTool({ name: 'lodge_feed', arguments: {} });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /today's Men of Hunger AI connection limit of 2 requests/);
  assert.equal(api.calls.length, before);
  assert.deepEqual(await allowance.usage('u1'), { used: 2, limit: 2, remaining: 0, resetsAt: '2026-09-24T00:00:00.000Z' });
  await client.listTools();
  assert.equal((await allowance.usage('u1')).used, 2);
  assert.equal((await allowance.usage('someone-else')).used, 0);
});

test('burst limit rejects rapid calls within one minute', async () => {
  const allowance = memberAllowance(new CounterRedis(), { daily: 100, perMinute: 2, now: () => 0 });
  await allowance.consume('u1');
  await allowance.consume('u1');
  await assert.rejects(allowance.consume('u1'), /last minute/);
});
