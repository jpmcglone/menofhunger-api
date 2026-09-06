#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { StateStore } from './state.mjs';
import { MohApi } from './api.mjs';
import { createTools } from './tools.mjs';
import {
  parseCommand,
  describeTools,
  helpText,
  formatHuman,
} from './commands.mjs';

let store;
let api;

async function login() {
  if (!process.stdin.isTTY)
    throw new Error(
      'Run login in an interactive terminal; do not pass phone numbers or codes as arguments.',
    );
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stderr.write(chunk);
      callback();
    },
  });
  const reader = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  try {
    process.stderr.write(
      `Sign in to ${api.baseUrl} with your own administrator account.\n`,
    );
    muted = true;
    process.stderr.write('Phone number (hidden): ');
    const phone = (await reader.question('')).trim();
    process.stderr.write('\n');
    if (!/^\+?[0-9 ()-]{7,25}$/.test(phone))
      throw new Error('Enter a valid phone number.');
    if (!(await api.accountExists(phone)))
      throw new Error(
        'No existing account matches this phone number. Sign in with your administrator account.',
      );
    await api.auth('auth/phone/start', { phone });
    process.stderr.write('SMS code (hidden): ');
    const code = (await reader.question('')).trim();
    process.stderr.write('\n');
    if (!/^\d{6}$/.test(code)) throw new Error('Enter the six-digit SMS code.');
    await api.auth('auth/phone/verify', { phone, code });
    try {
      const identity = await api.identity();
      process.stderr.write(
        `Connected as @${identity.username || identity.id}. Session stored privately on this computer.\n`,
      );
    } catch (error) {
      await api.auth('auth/logout').catch(() => {});
      await store.remove(api.credentials);
      throw error;
    }
  } finally {
    reader.close();
  }
}

try {
  const { command, toolName, args, json, help } = await parseCommand(
    process.argv.slice(2),
  );
  store = new StateStore();
  api = new MohApi({ store });
  const tools = createTools({ api, store });
  const print = (data) =>
    process.stdout.write(
      (json
        ? JSON.stringify({ ok: true, data, error: null })
        : formatHuman(data)) + '\n',
    );
  if (
    command === 'help' ||
    (help &&
      ['login', 'logout', 'configure', 'tools', 'version'].includes(command))
  ) {
    if (json) print({ help: helpText });
    else process.stdout.write(helpText);
  } else if (command === 'tools') {
    const catalog = describeTools(tools);
    if (json) print(catalog);
    else
      process.stdout.write(
        catalog
          .map(
            (tool) =>
              `${tool.command.padEnd(18)} ${tool.name}\n  ${tool.description}`,
          )
          .join('\n\n') + '\n',
      );
  } else if (command === 'version') print({ version: '0.1.0' });
  else if (command === 'configure') {
    const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url));
    try {
      await promisify(execFile)(
        'codex',
        [
          'mcp',
          'add',
          'menofhunger',
          '--env',
          `MOH_API_BASE_URL=${api.baseUrl}`,
          '--env',
          `MOH_MCP_STATE_DIR=${store.directory}`,
          '--',
          'node',
          serverPath,
        ],
        { timeout: 30_000 },
      );
    } catch {
      throw new Error(
        'Could not configure Codex. Ensure codex and node are on PATH and the Codex configuration is writable.',
      );
    }
    print({
      configured: true,
      name: 'menofhunger',
      environment: api.baseUrl,
      serverPath,
      nextStep:
        'Sign in with moh login, then reload MCP tools or start a new Codex session. The current tool catalog may need to refresh.',
    });
  } else if (command === 'login') {
    await login();
    if (json) print({ connected: true, environment: api.baseUrl });
  } else if (command === 'logout') {
    if (!(await api.session())) {
      await store.remove(api.credentials);
      print({ localSessionRemoved: true, serverSessionRevoked: false });
    } else {
      try {
        await api.auth('auth/logout');
      } catch (error) {
        throw new Error(
          `Server revocation failed; local session removed. ${error.message}`,
        );
      } finally {
        await store.remove(api.credentials);
      }
      print({ localSessionRemoved: true, serverSessionRevoked: true });
    }
  } else {
    const tool = tools.find((item) => item.name === toolName);
    if (!tool) throw new Error('Unknown command. Run moh help or moh tools.');
    if (help) print(describeTools([tool])[0]);
    else print(await tool.execute(args));
  }
} catch (error) {
  const message =
    error.name === 'ZodError'
      ? 'Invalid tool arguments. Run this command with --help for its schema.'
      : error.message;
  if (process.argv.includes('--json'))
    process.stdout.write(
      JSON.stringify({
        ok: false,
        data: null,
        error: { message, status: error.status || null },
      }) + '\n',
    );
  else process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
