import { SpacesIdleCleanupCron } from './spaces-idle-cleanup.cron';

describe('SpacesIdleCleanupCron', () => {
  function build(opts: { runHttp: boolean; runSchedulers: boolean }) {
    const appConfig = {
      runHttp: jest.fn(() => opts.runHttp),
      runSchedulers: jest.fn(() => opts.runSchedulers),
    };
    const prisma = {
      space: { findMany: jest.fn(async () => [{ id: 'space-1' }]) },
    };
    const spaces = { deactivateIfActive: jest.fn(async () => true) };
    const spacesPresence = { ensureEmptyStamp: jest.fn(async () => Date.now() - 10 * 60_000) };
    const cron = new SpacesIdleCleanupCron(
      appConfig as any,
      prisma as any,
      spaces as any,
      spacesPresence as any,
    );
    return { cron, prisma, spaces, spacesPresence, appConfig };
  }

  it('no-ops when runHttp is false (worker-only process)', async () => {
    const { cron, prisma, spaces } = build({ runHttp: false, runSchedulers: true });
    await cron.sweepAbandonedLiveSpaces();
    expect(prisma.space.findMany).not.toHaveBeenCalled();
    expect(spaces.deactivateIfActive).not.toHaveBeenCalled();
  });

  it('no-ops when runSchedulers is false', async () => {
    const { cron, prisma } = build({ runHttp: true, runSchedulers: false });
    await cron.sweepAbandonedLiveSpaces();
    expect(prisma.space.findMany).not.toHaveBeenCalled();
  });

  it('closes empty live spaces when both gates pass', async () => {
    const { cron, spaces, spacesPresence } = build({ runHttp: true, runSchedulers: true });
    await cron.sweepAbandonedLiveSpaces();
    expect(spacesPresence.ensureEmptyStamp).toHaveBeenCalledWith('space-1');
    expect(spaces.deactivateIfActive).toHaveBeenCalledWith('space-1');
  });
});
