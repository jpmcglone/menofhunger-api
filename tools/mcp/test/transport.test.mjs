import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { StateStore } from '../src/state.mjs';

test('real stdio MCP handshake, tools, resources, prompts, validation and unauthenticated status', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moh-transport-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
    env: { MOH_MCP_STATE_DIR: directory },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: 'moh-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 23);
  assert.ok(
    tools.tools.find((tool) => tool.name === 'founder_briefing').annotations
      .readOnlyHint,
  );
  assert.equal(
    tools.tools.find((tool) => tool.name === 'record_decision').annotations
      .readOnlyHint,
    false,
  );
  const status = await client.callTool({
    name: 'connection_status',
    arguments: {},
  });
  assert.equal(status.structuredContent.connected, false);
  const invalid = await client.callTool({
    name: 'member_diagnostics',
    arguments: { memberId: '../evil' },
  });
  assert.equal(invalid.isError, true);
  const resources = await client.listResources();
  assert.equal(resources.resources.length, 2);
  assert.match(
    (await client.readResource({ uri: 'moh://metrics' })).contents[0].text,
    /not cash receipts/,
  );
  assert.equal((await client.listPrompts()).prompts.length, 4);
  assert.equal(stderr, '');
});

test('CLI machine discovery and errors use stable JSON and exit status', async () => {
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const exec = promisify(execFile);
  const { stdout, stderr } = await exec(process.execPath, [
    cli,
    'tools',
    '--json',
  ]);
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.data.length, 23);
  await assert.rejects(
    exec(process.execPath, [cli, 'feedback', '--limit', '999', '--json']),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).ok, false);
      return true;
    },
  );
});

test('authenticated MCP and CLI reach the same HTTP API and return the same redacted evidence', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moh-live-transport-test-'));
  const requests = [];
  const http = createServer((req, res) => {
    requests.push({ url: req.url, cookie: req.headers.cookie });
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.cookie !== 'moh_session=fixture-secret') {
      res.writeHead(401).end(JSON.stringify({ meta: { status: 401 } }));
      return;
    }
    if (req.url === '/v1/auth/me')
      res.end(
        JSON.stringify({
          data: {
            id: 'admin',
            username: 'founder',
            siteAdmin: true,
            phone: 'private',
          },
        }),
      );
    else if (req.url.startsWith('/v1/admin/feedback'))
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'f1',
              subject: 'Example issue',
              email: 'private@example.com',
            },
          ],
          pagination: { nextCursor: null },
        }),
      );
    else if (req.url === '/v1/admin/operations/health')
      res.end(JSON.stringify({ data: { pendingReports: 2 } }));
    else res.writeHead(404).end(JSON.stringify({ meta: { status: 404 } }));
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(() => {
    http.closeAllConnections();
    http.close();
  });
  const baseUrl = `http://127.0.0.1:${http.address().port}/v1`;
  const store = new StateStore(directory);
  await store.write(store.credentialName(baseUrl), {
    baseUrl,
    token: 'fixture-secret',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const env = {
    ...process.env,
    MOH_API_BASE_URL: baseUrl,
    MOH_MCP_STATE_DIR: directory,
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
    env,
    stderr: 'pipe',
  });
  const client = new Client({
    name: 'moh-authenticated-test',
    version: '1.0.0',
  });
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.connect(transport);
  const status = await client.callTool({
    name: 'connection_status',
    arguments: {},
  });
  assert.equal(status.structuredContent.connected, true);
  assert.equal(status.structuredContent.diagnostics.available, true);
  assert.equal(JSON.stringify(status).includes('private'), false);
  const result = await client.callTool({
    name: 'feedback',
    arguments: { status: 'new', limit: 5 },
  });
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [cli, 'feedback', '--status', 'new', '--limit', '5', '--json'],
    { env },
  );
  const fromCli = JSON.parse(stdout);
  assert.deepEqual(fromCli.data.data, result.structuredContent.data);
  assert.equal(JSON.stringify(result).includes('private@example.com'), false);
  assert.equal(fromCli.data.source.url, result.structuredContent.source.url);
  assert.ok(
    requests.every((req) => req.cookie === 'moh_session=fixture-secret'),
  );
});
