import { NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { McpController } from './mcp.controller';
import { AdminMcpConnectionsController } from './admin-mcp-connections.controller';

const usage = { used: 3, limit: 200, remaining: 197, resetsAt: '2026-09-25T00:00:00.000Z' };
const row = { id: 'a'.repeat(64), clientName: 'ChatGPT', audience: 'member', createdAt: null, lastUsedAt: null, expiresAt: '2026-10-24T00:00:00.000Z' };
const session = (extra: Record<string, unknown> = {}, user: Record<string, unknown> = {}) => ({
  user: { id: 'u1', username: 'brother', accountKind: 'person', premium: true, siteAdmin: false, bannedAt: null, ...user },
  impersonatedByUserId: null,
  operatedByUserId: null,
  ...extra,
});

function setup(current: unknown) {
  const auth = { meFromSessionToken: jest.fn().mockResolvedValue(current) };
  const connections = {
    url: 'https://api.example/mcp',
    usage: jest.fn().mockResolvedValue(usage),
    list: jest.fn().mockResolvedValue([row]),
    revoke: jest.fn().mockResolvedValue(true),
  };
  const req = { cookies: { moh_session: 'browser' }, headers: {} } as unknown as Request;
  const res = { setHeader: jest.fn() } as unknown as Response;
  return { auth, connections, req, res, controller: new McpController(auth as never, connections as never) };
}

describe('McpController', () => {
  it('returns the URL, usage, and own connections for a Premium member', async () => {
    const { controller, connections, req, res } = setup(session());
    const { data } = await controller.connection(req, res);
    expect(data).toEqual({ url: 'https://api.example/mcp', audience: 'member', usage, connections: [row] });
    expect(connections.list).toHaveBeenCalledWith('u1');
  });

  it('still lists connections after Premium ends so they can be removed', async () => {
    const { controller, req, res } = setup(session({}, { premium: false }));
    const { data } = await controller.connection(req, res);
    expect(data.audience).toBeNull();
    expect(data.usage).toBeNull();
    expect(data.connections).toEqual([row]);
  });

  it('hides and refuses connection management in impersonated or page-operated sessions', async () => {
    for (const extra of [{ impersonatedByUserId: 'admin' }, { operatedByUserId: 'owner' }]) {
      const { controller, connections, req, res } = setup(session(extra));
      expect((await controller.connection(req, res)).data.connections).toEqual([]);
      await expect(controller.revoke(req, row.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(connections.revoke).not.toHaveBeenCalled();
    }
  });

  it('revokes only the signed-in person’s connection and 404s unknown IDs', async () => {
    const { controller, connections, req } = setup(session());
    await expect(controller.revoke(req, row.id)).resolves.toEqual({ data: { revoked: true } });
    expect(connections.revoke).toHaveBeenCalledWith('u1', row.id);
    connections.revoke.mockResolvedValueOnce(false);
    await expect(controller.revoke(req, 'b'.repeat(64))).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AdminMcpConnectionsController', () => {
  it('lists a member’s connections with today’s usage and revokes by ID', async () => {
    const { connections } = setup(session());
    const controller = new AdminMcpConnectionsController(connections as never);
    await expect(controller.list('u2')).resolves.toEqual({ data: { usage, connections: [row] } });
    expect(connections.list).toHaveBeenCalledWith('u2');
    await expect(controller.revoke('u2', row.id)).resolves.toEqual({ data: { revoked: true } });
    expect(connections.revoke).toHaveBeenCalledWith('u2', row.id);
    connections.revoke.mockResolvedValueOnce(false);
    await expect(controller.revoke('u2', row.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
