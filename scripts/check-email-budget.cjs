// Bounded local Redis concurrency check. Never reads application credentials.
require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Redis = require('ioredis');
const { RESERVE_EMAIL_BUDGET, RECONCILE_EMAIL_BUDGET } = require('../src/modules/email/email-budget.service');
const prefix = `moh-test-email-budget:${randomUUID()}`;
const touched = new Set();
const client = new Redis('redis://127.0.0.1:6379', { maxRetriesPerRequest: 0, retryStrategy: () => null, connectTimeout: 2000 });
client.on('error', () => {});
function keys(bucket, id, user = 'user') {
  const names = [`${prefix}:${bucket}:count`, `${prefix}:${bucket}:user:${user}`, `${prefix}:${bucket}:event:${id}`];
  names.forEach(key => touched.add(key));
  return names;
}
const reserve = (names, limit = 10, cap = false, id = 'delivery') => client.eval(RESERVE_EMAIL_BUDGET, 3, ...names, limit, cap ? '1' : '0', id, 60000, 60000);
const reconcile = (names, state, cap = false, id = 'delivery') => client.eval(RECONCILE_EMAIL_BUDGET, 3, ...names, state, cap ? '1' : '0', id);
(async () => {
  try {
    await client.ping();
    const fanout = await Promise.all(Array.from({ length: 40 }, (_, index) => reserve(keys('fanout', String(index)))));
    assert.equal(fanout.filter(result => result === 1).length, 10);
    assert.equal(await client.get(keys('fanout', 'unused')[0]), '10');

    const same = keys('same', 'event');
    const duplicates = await Promise.all(Array.from({ length: 40 }, () => reserve(same)));
    assert(duplicates.every(result => result === 1));
    assert.equal(await client.get(same[0]), '1');
    await reconcile(same, 'uncertain');
    await reconcile(same, 'rejected');
    assert.equal(await client.get(same[0]), '1');
    await reserve(same);
    assert.equal(await client.get(same[0]), '1');

    const optional = await Promise.all(Array.from({ length: 25 }, (_, index) => reserve(keys('cap', String(index)), 100, true, String(index))));
    assert.equal(optional.filter(result => result === 1).length, 1);
    assert.equal(optional.filter(result => result === 3).length, 24);
    assert.equal(await reserve(keys('cap', 'invitation'), 100, false, 'invitation'), 1);
    assert.equal(await client.get(keys('cap', 'unused')[0]), '2');

    const rejected = keys('rejected', 'event');
    assert.equal(await reserve(rejected, 10, true), 1);
    await reconcile(rejected, 'rejected', true);
    assert.equal(await client.get(rejected[0]), '0');
    assert.equal(await client.exists(rejected[1]), 0);
    assert.equal(await reserve(rejected, 10, true), 1);

    const accepted = keys('accepted', 'event');
    await reserve(accepted);
    await reconcile(accepted, 'accepted');
    await reconcile(accepted, 'rejected');
    assert.equal(await client.get(accepted[0]), '1');
    assert((await client.pttl(accepted[0])) > 0);
    console.log('5 local Redis budget checks passed: concurrent quota, idempotent ambiguity, user cap priority, definitive rejection release, accepted-slot retention.');
  } finally {
    if (client.status === 'ready' && touched.size) await client.del(...touched);
    client.disconnect();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
