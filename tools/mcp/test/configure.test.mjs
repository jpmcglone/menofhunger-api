import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_CONFIG_ERROR,
  configureDesktopClients,
  cursorMcpConfigPath,
  mergeCursorMcpConfig,
  stdioServer,
  writeCursorMcpConfig,
} from '../src/configure.mjs';
import { formatHuman } from '../src/commands.mjs';

const server = stdioServer({
  serverPath: '/repo/tools/mcp/src/server.mjs',
  baseUrl: 'https://api.menofhunger.com/v1',
  stateDir: '/tmp/menofhunger-mcp',
});

test('Cursor MCP path stays in the user config, not the repository', () => {
  assert.equal(
    cursorMcpConfigPath('/Users/founder'),
    join('/Users/founder', '.cursor', 'mcp.json'),
  );
});

test('Cursor MCP merge replaces only the named Men of Hunger server', () => {
  const next = mergeCursorMcpConfig(
    JSON.stringify({
      mcpServers: {
        linear: { command: 'npx', args: ['linear'] },
        menofhunger: { command: 'old' },
      },
    }),
    'menofhunger',
    server,
  );
  assert.deepEqual(next.mcpServers.linear, { command: 'npx', args: ['linear'] });
  assert.deepEqual(next.mcpServers.menofhunger, server);
  const local = mergeCursorMcpConfig(
    JSON.stringify(next),
    'menofhunger-local',
    stdioServer({
      serverPath: server.args[0],
      baseUrl: 'http://localhost:3001/v1',
      stateDir: server.env.MOH_MCP_STATE_DIR,
    }),
  );
  assert.equal(local.mcpServers.menofhunger.env.MOH_API_BASE_URL.endsWith('/v1'), true);
  assert.equal(
    local.mcpServers['menofhunger-local'].env.MOH_API_BASE_URL,
    'http://localhost:3001/v1',
  );
  assert.throws(
    () => mergeCursorMcpConfig('[]', 'menofhunger', server),
    /JSON object/,
  );
  assert.throws(
    () => mergeCursorMcpConfig('{"mcpServers":[]}', 'menofhunger', server),
    /mcpServers/,
  );
});

test('Cursor MCP write creates and updates ~/.cursor/mcp.json without dropping neighbors', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'moh-cursor-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = cursorMcpConfigPath(home);
  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ mcpServers: { slack: { command: 'npx' } } }, null, 2),
  );
  assert.equal(
    await writeCursorMcpConfig({ path, name: 'menofhunger', server }),
    path,
  );
  const written = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(written.mcpServers.slack, { command: 'npx' });
  assert.deepEqual(written.mcpServers.menofhunger, server);
});

test('desktop configure registers Cursor when Codex is unavailable', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'moh-configure-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const result = await configureDesktopClients({
    name: 'menofhunger',
    serverPath: server.args[0],
    baseUrl: server.env.MOH_API_BASE_URL,
    stateDir: server.env.MOH_MCP_STATE_DIR,
    cursorConfigPath: cursorMcpConfigPath(home),
    execFile: async () => {
      throw new Error('codex missing');
    },
  });
  assert.equal(result.configured, true);
  assert.equal(result.clients.cursor.configured, true);
  assert.equal(result.clients.codex.configured, false);
  assert.equal(result.clients.codex.reason, CODEX_CONFIG_ERROR);
  assert.match(
    formatHuman(result),
    /Cursor: .*mcp\.json[\s\S]*Codex: not configured/,
  );
});

test('desktop configure registers Codex when Cursor config is unusable', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'moh-configure-codex-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = cursorMcpConfigPath(home);
  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(path, 'not-json');
  const calls = [];
  const result = await configureDesktopClients({
    name: 'menofhunger',
    serverPath: server.args[0],
    baseUrl: server.env.MOH_API_BASE_URL,
    stateDir: server.env.MOH_MCP_STATE_DIR,
    cursorConfigPath: path,
    execFile: async (...args) => {
      calls.push(args);
    },
  });
  assert.equal(result.clients.cursor.configured, false);
  assert.match(result.clients.cursor.reason, /valid JSON/);
  assert.equal(result.clients.codex.configured, true);
  assert.equal(calls[0][0], 'codex');
  assert.match(formatHuman(result), /Cursor: not configured[\s\S]*Codex: registered/);
});

test('desktop configure fails only when both clients fail', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'moh-configure-none-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = cursorMcpConfigPath(home);
  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(path, 'not-json');
  await assert.rejects(
    configureDesktopClients({
      name: 'menofhunger',
      serverPath: server.args[0],
      baseUrl: server.env.MOH_API_BASE_URL,
      stateDir: server.env.MOH_MCP_STATE_DIR,
      cursorConfigPath: path,
      execFile: async () => {
        throw new Error('codex missing');
      },
    }),
    /Could not configure Cursor or Codex/,
  );
});
