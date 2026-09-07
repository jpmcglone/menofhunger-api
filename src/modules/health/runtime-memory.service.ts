import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { getHeapStatistics } from 'node:v8';
import { AppConfigService } from '../app/app-config.service';

/** Separate JS heap growth from native image/buffer memory in production logs. */
@Injectable()
export class RuntimeMemoryService implements OnModuleInit {
  private readonly logger = new Logger(RuntimeMemoryService.name);

  constructor(private readonly appConfig: AppConfigService) {}

  onModuleInit() {
    this.record();
  }

  @Interval(60_000)
  record() {
    if (!this.appConfig.isProd()) return;
    const memory = process.memoryUsage();
    const limit = process.constrainedMemory();
    const mib = (bytes: number) => Math.round(bytes / 1024 / 1024);
    const sample = {
      event: 'runtime_memory',
      rssMiB: mib(memory.rss),
      heapUsedMiB: mib(memory.heapUsed),
      heapTotalMiB: mib(memory.heapTotal),
      externalMiB: mib(memory.external),
      arrayBuffersMiB: mib(memory.arrayBuffers),
      heapLimitMiB: mib(getHeapStatistics().heap_size_limit),
      containerLimitMiB: limit > 0 ? mib(limit) : null,
      uptimeSeconds: Math.round(process.uptime()),
    };
    if (limit > 0 && memory.rss >= limit * 0.8) this.logger.warn(sample);
    else this.logger.log(sample);
  }
}
