import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const defaultExecFile = promisify(execFileCallback);

export const CODEX_CONFIG_ERROR =
  'Could not run `codex mcp add`. Install the Codex CLI and keep `codex` on PATH, or add the same stdio server under [mcp_servers.menofhunger] in ~/.codex/config.toml.';

export function cursorMcpConfigPath(home = homedir()) {
  return join(home, '.cursor', 'mcp.json');
}

export function stdioServer({ serverPath, baseUrl, stateDir }) {
  return {
    command: 'node',
    args: [serverPath],
    env: {
      MOH_API_BASE_URL: baseUrl,
      MOH_MCP_STATE_DIR: stateDir,
    },
  };
}

export function mergeCursorMcpConfig(existingText, name, server) {
  let parsed = {};
  if (existingText?.trim()) {
    parsed = JSON.parse(existingText);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Cursor MCP configuration must be a JSON object.');
  }
  const servers = parsed.mcpServers;
  if (
    servers !== undefined &&
    (servers === null || typeof servers !== 'object' || Array.isArray(servers))
  )
    throw new Error('Cursor mcpServers must be a JSON object.');
  return {
    ...parsed,
    mcpServers: {
      ...servers,
      [name]: server,
    },
  };
}

export async function writeCursorMcpConfig({ path, name, server }) {
  await mkdir(dirname(path), { recursive: true });
  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing.length > 200_000)
    throw new Error('Cursor MCP configuration exceeds the size limit.');
  const next = mergeCursorMcpConfig(existing, name, server);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', {
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return path;
}

export async function registerCodex({
  name,
  serverPath,
  baseUrl,
  stateDir,
  execFile = defaultExecFile,
}) {
  await execFile(
    'codex',
    [
      'mcp',
      'add',
      name,
      '--env',
      `MOH_API_BASE_URL=${baseUrl}`,
      '--env',
      `MOH_MCP_STATE_DIR=${stateDir}`,
      '--',
      'node',
      serverPath,
    ],
    { timeout: 30_000 },
  );
}

export async function configureDesktopClients({
  name,
  serverPath,
  baseUrl,
  stateDir,
  cursorConfigPath = cursorMcpConfigPath(),
  execFile = defaultExecFile,
}) {
  const server = stdioServer({ serverPath, baseUrl, stateDir });
  const clients = {};
  try {
    clients.cursor = {
      configured: true,
      path: await writeCursorMcpConfig({
        path: cursorConfigPath,
        name,
        server,
      }),
    };
  } catch (error) {
    clients.cursor = {
      configured: false,
      reason:
        error instanceof SyntaxError
          ? 'Cursor MCP configuration is not valid JSON.'
          : error.message,
    };
  }
  try {
    await registerCodex({ name, serverPath, baseUrl, stateDir, execFile });
    clients.codex = { configured: true };
  } catch {
    clients.codex = { configured: false, reason: CODEX_CONFIG_ERROR };
  }
  if (!clients.cursor.configured && !clients.codex.configured) {
    throw new Error(
      `Could not configure Cursor or Codex. ${clients.cursor.reason} ${clients.codex.reason}`,
    );
  }
  return {
    configured: true,
    name,
    environment: baseUrl,
    serverPath,
    clients,
    nextStep:
      'Sign in with moh login, then reload MCP tools or start a new Cursor or Codex session. The current tool catalog may need to refresh.',
  };
}
