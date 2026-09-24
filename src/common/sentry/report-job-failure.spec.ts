import * as Sentry from '@sentry/nestjs';
import type { Job } from 'bullmq';
import { reportJobFailure } from './report-job-failure';

jest.mock('@sentry/nestjs', () => {
  const scope = { setTag: jest.fn(), setContext: jest.fn(), setFingerprint: jest.fn() };
  return {
    captureException: jest.fn(),
    withScope: jest.fn((fn: (s: typeof scope) => void) => fn(scope)),
  };
});

const job = (attemptsMade: number, attempts?: number) =>
  ({ id: '1', name: 'posts.sweep', attemptsMade, opts: attempts ? { attempts } : {} }) as unknown as Job;

describe('reportJobFailure', () => {
  beforeEach(() => jest.clearAllMocks());

  it('stays quiet while retries remain', () => {
    expect(reportJobFailure('moh_background', job(1, 3), new Error('boom'))).toBe(false);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('reports once the final attempt fails', () => {
    const error = new Error('boom');
    expect(reportJobFailure('moh_background', job(3, 3), error)).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it('treats jobs without retry options as single-attempt', () => {
    expect(reportJobFailure('moh_side_effects', job(1), new Error('boom'))).toBe(true);
  });

  it('ignores a missing job', () => {
    expect(reportJobFailure('moh_background', undefined, new Error('boom'))).toBe(false);
  });
});
