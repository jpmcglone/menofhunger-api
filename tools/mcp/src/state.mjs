import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class StateStore {
  constructor(
    directory = process.env.MOH_MCP_STATE_DIR ||
      join(homedir(), '.local/share/menofhunger-mcp'),
  ) {
    this.directory = resolve(directory);
  }

  async ready(create = true) {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new Error(
        'MCP state directory must be owned by you with permissions 700.',
      );
    }
  }

  path(name) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(name))
      throw new Error('Invalid state file name.');
    return join(this.directory, name);
  }

  async read(name) {
    let file;
    try {
      await this.ready(false);
      file = await open(
        this.path(name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid())
      ) {
        throw new Error(
          'MCP state files must be private, regular files owned by you.',
        );
      }
      if (stat.size > 200_000)
        throw new Error('MCP state file exceeds the size limit.');
      return JSON.parse(await file.readFile('utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    } finally {
      await file?.close();
    }
  }

  async write(name, value) {
    await this.ready();
    const temporary = this.path(`tmp-${randomUUID()}.json`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + '\n');
      await file.close();
      await rename(temporary, this.path(name));
    } finally {
      await file.close();
      await unlink(temporary).catch(() => {});
    }
  }

  async remove(name) {
    await this.ready();
    await unlink(this.path(name)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  credentialName(baseUrl) {
    return `session-${createHash('sha256').update(baseUrl).digest('hex').slice(0, 20)}.json`;
  }

  async withPublishingLock(baseUrl, callback) {
    await this.ready();
    const name = this.credentialName(baseUrl).replace('session-', 'publishing-lock-');
    let file;
    try {
      file = await open(this.path(name), 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new Error('Publishing is already in progress. If it was interrupted, verify the post and sign in again before removing the stale publishing lock. Do not retry the post blindly.');
      throw error;
    }
    try {
      return await callback();
    } finally {
      await file.close();
      await this.remove(name);
    }
  }

  async saveArtifact(kind, value, environment) {
    const id = randomUUID();
    const entry = {
      id,
      kind,
      environment,
      createdAt: new Date().toISOString(),
      ...value,
    };
    await this.write(`${kind}-${id}.json`, entry);
    return {
      ...entry,
      path: this.path(`${kind}-${id}.json`),
      location: 'local-only',
    };
  }

  async artifacts(kind, environment, limit = 20) {
    try {
      await this.ready(false);
    } catch (error) {
      if (error.code === 'ENOENT')
        return { entries: [], total: 0, location: 'local-only' };
      throw error;
    }
    const names = (await readdir(this.directory)).filter(
      (name) => name.startsWith(`${kind}-`) && name.endsWith('.json'),
    );
    const entries = [];
    for (const name of names) {
      const entry = await this.read(name);
      if (entry?.environment === environment) entries.push(entry);
    }
    entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      entries: entries.slice(0, limit),
      total: entries.length,
      location: 'local-only',
    };
  }
}
