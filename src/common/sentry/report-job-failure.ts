import * as Sentry from '@sentry/nestjs';
import type { Job } from 'bullmq';

/** Reports a BullMQ job only once its retries are exhausted, so transient retries stay quiet. */
export function reportJobFailure(queue: string, job: Job | undefined, error: Error): boolean {
  if (!job) return false;
  const attempts = job.opts?.attempts ?? 1;
  if (job.attemptsMade < attempts) return false;
  Sentry.withScope((scope) => {
    scope.setTag('queue', queue);
    scope.setTag('job_name', String(job.name ?? 'unknown'));
    scope.setContext('job', { id: job.id ?? null, attemptsMade: job.attemptsMade, attempts });
    scope.setFingerprint(['bullmq', queue, String(job.name ?? 'unknown'), error.name, error.message]);
    Sentry.captureException(error);
  });
  return true;
}
