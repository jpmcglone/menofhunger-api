import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state.mjs';
import { createTools, retentionWithMaturity } from '../src/tools.mjs';
import { parseCommand, describeTools, formatHuman } from '../src/commands.mjs';

test('CLI aliases, flags and generic calls resolve to the same validated tool arguments', async () => {
  assert.deepEqual(
    (
      await parseCommand([
        'analytics',
        '--area',
        'retention',
        '--range',
        '30d',
        '--json',
      ])
    ).args,
    { area: 'retention', range: '30d' },
  );
  assert.equal((await parseCommand(['members', '12345'])).args.q, '12345');
  assert.equal(
    (await parseCommand(['diagnose', 'member1'])).args.memberId,
    'member1',
  );
  assert.deepEqual(
    (await parseCommand(['content', '--unanswered', '--limit', '5'])).args,
    { unanswered: true, limit: 5 },
  );
  assert.equal(
    (await parseCommand(['call', 'member_profile', '{"username":"bob"}']))
      .toolName,
    'member_profile',
  );
  await assert.rejects(
    parseCommand(['feedback', '--limit', '2', '--limit', '3']),
    /Duplicate/,
  );
  await assert.rejects(parseCommand(['member', 'bob', 'extra']), /Expected/);
});

test('invalid tool arguments fail before the API is called; member contact fields stay out', async () => {
  let calls = 0;
  const api = {
    baseUrl: 'https://api.menofhunger.com/v1',
    get: async () => {
      calls++;
      return {
        data: [
          {
            id: 'u1',
            name: 'Bob',
            phone: 'private',
            email: 'private',
            locationZip: 'private',
          },
        ],
      };
    },
  };
  const tools = createTools({ api, store: {} });
  const search = tools.find((tool) => tool.name === 'search_members');
  await assert.rejects(search.execute({ q: 'bob', limit: 500 }));
  await assert.rejects(search.execute({ q: 'bob', unexpected: 'value' }));
  assert.equal(calls, 0);
  assert.deepEqual((await search.execute({ q: 'bob' })).data, [
    { id: 'u1', name: 'Bob' },
  ]);
  const catalog = describeTools(tools);
  assert.equal(catalog.length, tools.length);
  assert.ok(
    catalog.every((tool) => tool.inputSchema.additionalProperties === false),
  );
});

test('incomplete retention cohorts are never rendered as measured zero retention', () => {
  const rows = [
    { cohortWeek: '2026-08-24', size: 10, w1: 2, w4: 0 },
    { cohortWeek: '2026-07-06', size: 10, w1: 8, w4: 4 },
  ];
  const result = retentionWithMaturity(rows, '2026-09-05T12:00:00Z');
  assert.equal(result[0].week1.complete, false);
  assert.equal(result[0].week1.percentage, null);
  assert.equal(result[0].week4.percentage, null);
  assert.equal(result[1].week4.percentage, 40);
  assert.equal(
    retentionWithMaturity([{ ...rows[1], size: 0 }], '2026-09-05T12:00:00Z')[0]
      .week4.percentage,
    null,
  );
});

test('human output keeps analytics data and calls unavailable queue data out', () => {
  assert.match(
    formatHuman({
      data: { summary: { totalUsers: 42 } },
      definitions: 'See metrics',
    }),
    /42/,
  );
  const rendered = formatHuman({
    range: '7d',
    asOf: '2026-09-05T12:00:00Z',
    environment: 'test',
    sections: {
      business: {
        available: true,
        data: {
          summary: {
            totalUsers: 42,
            dau: 8,
            mau: 20,
            premiumUsers: 10,
            premiumPlusUsers: 3,
          },
          engagement: { d30RetentionPct: null, d30CohortSize: 0 },
        },
      },
      queue_health: {
        available: true,
        data: {
          queues: [
            { name: 'jobs', workers: 0, failed: 0, error: 'Redis offline' },
          ],
        },
      },
      operations_health: { available: false, reason: 'Not deployed' },
    },
  });
  assert.match(rendered, /42/);
  assert.match(rendered, /not measurable/);
  assert.match(rendered, /jobs: unavailable/);
  assert.doesNotMatch(rendered, /jobs: workers=0/);
  assert.match(rendered, /Unavailable — operations_health/);
});

test('founder briefing preserves good sections and marks failed sections unavailable', async () => {
  const api = {
    baseUrl: 'https://api.menofhunger.com/v1',
    get: async (path) => {
      if (path === 'admin/jobs/queues')
        throw new Error('Queue service unavailable');
      return {
        data:
          path === 'admin/analytics'
            ? {
                range: '7d',
                asOf: '2026-09-05T12:00:00Z',
                summary: { totalUsers: 42 },
              }
            : [],
        source: { url: path, fetchedAt: '2026-09-05T12:00:00Z' },
      };
    },
  };
  const tool = createTools({ api, store: {} }).find(
    (tool) => tool.name === 'founder_briefing',
  );
  const result = await tool.execute({});
  assert.equal(result.sections.business.data.summary.totalUsers, 42);
  assert.equal(result.sections.queue_health.available, false);
  assert.equal(Object.hasOwn(result.sections.queue_health, 'data'), false);
  api.get = async () => {
    throw new Error('Offline');
  };
  await assert.rejects(tool.execute({}), /No briefing sections/);
});

test('decisions and drafts write only local files and are isolated by API environment', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moh-artifacts-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory);
  const api = {
    baseUrl: 'https://api.menofhunger.com/v1',
    get: () => {
      throw new Error('No network expected');
    },
  };
  const tools = createTools({ api, store });
  const decision = await tools
    .find((tool) => tool.name === 'record_decision')
    .execute({
      title: 'Improve introductions',
      decision: 'Test clearer onboarding copy',
      rationale: 'A member reported confusion',
      evidence: [
        {
          source: 'https://menofhunger.com/admin/feedback',
          observation: 'Confusing first step',
          observedAt: '2026-09-05T12:00:00Z',
        },
      ],
      successMeasure: 'Compare first-week activation with the baseline',
      reviewOn: '2026-09-20',
    });
  assert.equal(decision.location, 'local-only');
  assert.equal((await store.artifacts('decision', api.baseUrl)).total, 1);
  assert.equal(
    (await store.artifacts('decision', 'http://localhost:3001/v1')).total,
    0,
  );
  const draft = await tools
    .find((tool) => tool.name === 'save_draft')
    .execute({
      kind: 'newsletter',
      title: 'Week in review',
      body: 'A local draft.',
    });
  assert.equal(draft.draftKind, 'newsletter');
  assert.equal((await store.artifacts('draft', api.baseUrl)).total, 1);
});
